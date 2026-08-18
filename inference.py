"""
EarVAE2 inference script — reconstruct audio through the autoencoder.

Usage:
    python inference.py --checkpoint model.pt --input input.wav --output output.wav
    python inference.py --checkpoint model.pt --input ./audio_dir/ --output ./output_dir/

Supports WAV, MP3, and FLAC inputs.  Output is always 48 kHz stereo PCM-24 WAV.
"""

import argparse
import json
import os
import glob as glob_mod
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
import librosa
import soundfile as sf

from ear_vae2 import EarVAE2


# ---------------------------------------------------------------------------
# Reproducibility
# ---------------------------------------------------------------------------

def set_deterministic():
    """Set torch to deterministic mode for reproducible inference."""
    torch.manual_seed(42)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False
    if hasattr(torch, "use_deterministic_algorithms"):
        torch.use_deterministic_algorithms(True, warn_only=True)


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

def load_config(config_path: str | None, checkpoint_path: str) -> dict:
    """Load model config from explicit path or auto-detect from checkpoint directory.

    Auto-detection looks for ``{checkpoint_dir}/../scripts/*.json`` and extracts
    the ``model.gen.config`` subtree.

    Args:
        config_path: Explicit path to a JSON config file, or None.
        checkpoint_path: Path to the checkpoint (used for auto-detection).

    Returns:
        Model config dictionary with keys like ``C0``, ``D``, ``use_vae``.
    """
    if config_path is not None:
        with open(config_path, "r") as f:
            cfg = json.load(f)
        # Navigate nested structure if present
        if "model" in cfg and "gen" in cfg["model"]:
            return cfg["model"]["gen"].get("config", cfg["model"]["gen"])
        return cfg

    # Auto-detect: look for scripts/*.json relative to checkpoint
    ckpt_dir = Path(checkpoint_path).parent
    scripts_dir = ckpt_dir.parent / "scripts"
    if scripts_dir.is_dir():
        json_files = list(scripts_dir.glob("*.json"))
        if json_files:
            with open(json_files[0], "r") as f:
                cfg = json.load(f)
            if "model" in cfg and "gen" in cfg["model"]:
                return cfg["model"]["gen"].get("config", cfg["model"]["gen"])
            return cfg

    # Fallback: default config
    print("[INFO] No config found, using default model config (C0=64, D=128, use_vae=True).")
    return {"C0": 64, "D": 128, "use_vae": True}


def load_model(checkpoint_path: str, config: dict, device: str) -> EarVAE2:
    """Load an EarVAE2 model from a checkpoint file.

    Supports multiple checkpoint formats:
        - ``gen_ema`` key with ``ema_model.`` prefix (EMA format)
        - ``gen`` key (standard training checkpoint)
        - Raw state_dict (plain torch.save)

    Args:
        checkpoint_path: Path to ``.pt`` / ``.pth`` checkpoint.
        config: Model config dictionary.
        device: Target device string.

    Returns:
        Loaded model in eval mode.
    """
    model = EarVAE2(config)
    ckpt = torch.load(checkpoint_path, map_location="cpu", weights_only=False)

    if isinstance(ckpt, dict):
        if "gen_ema" in ckpt:
            # EMA format: keep only the "ema_model." entries, then strip the prefix.
            state_dict = {
                k[len("ema_model."):]: v
                for k, v in ckpt["gen_ema"].items()
                if k.startswith("ema_model.")
            }
        elif "gen" in ckpt:
            state_dict = ckpt["gen"]
        elif "state_dict" in ckpt:
            state_dict = ckpt["state_dict"]
        else:
            # Assume the dict itself is a state_dict
            state_dict = ckpt
    else:
        raise ValueError(f"Unexpected checkpoint type: {type(ckpt)}")

    missing, unexpected = model.load_state_dict(state_dict, strict=False)
    if missing or unexpected:
        print(f"[WARN] load_state_dict mismatch — missing={len(missing)}, "
              f"unexpected={len(unexpected)}. The checkpoint may not match the config.")
        for k in missing[:5]:
            print(f"        missing: {k}")
        for k in unexpected[:5]:
            print(f"        unexpected: {k}")
    else:
        print("[INFO] Checkpoint loaded (all keys matched).")
    model = model.to(device).eval()
    return model


# ---------------------------------------------------------------------------
# Audio I/O
# ---------------------------------------------------------------------------

SAMPLE_RATE = 48000
TARGET_LUFS = -14.0


def load_audio(path: str) -> np.ndarray:
    """Load audio file as 48 kHz stereo float32 numpy array.

    Args:
        path: Path to WAV, MP3, or FLAC file.

    Returns:
        Array of shape ``(2, T)`` in float32, values in [-1, 1].
    """
    audio, sr = librosa.load(path, sr=SAMPLE_RATE, mono=False)
    if audio.ndim == 1:
        # Mono → stereo duplication
        audio = np.stack([audio, audio], axis=0)
    elif audio.shape[0] > 2:
        # Take first two channels
        audio = audio[:2]
    return audio.astype(np.float32)


def loudness_normalize(audio: np.ndarray, target_lufs: float = TARGET_LUFS) -> np.ndarray:
    """Normalize audio loudness to the target LUFS level.

    Args:
        audio: Shape ``(channels, samples)`` float32.
        target_lufs: Target integrated loudness. Default -14 LUFS.

    Returns:
        Loudness-normalized audio, same shape.
    """
    try:
        import pyloudnorm as pyln
    except ImportError:
        print("[WARN] pyloudnorm not installed, skipping loudness normalization.")
        return audio

    meter = pyln.Meter(SAMPLE_RATE)
    # pyloudnorm expects (samples, channels)
    audio_t = audio.T
    current_lufs = meter.integrated_loudness(audio_t)

    if np.isinf(current_lufs) or np.isnan(current_lufs):
        # Silent audio, skip normalization
        return audio

    normalized = pyln.normalize.loudness(audio_t, current_lufs, target_lufs)
    return normalized.T.astype(np.float32)


def save_audio(audio: np.ndarray, path: str) -> None:
    """Save audio as 48 kHz stereo PCM-24 WAV.

    Args:
        audio: Shape ``(2, T)`` float32 array.
        path: Output file path.
    """
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    # soundfile expects (samples, channels)
    sf.write(path, audio.T, SAMPLE_RATE, subtype="PCM_24")


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------

@torch.no_grad()
def process_file(model: EarVAE2, input_path: str, output_path: str,
                 device: str, chunk_size: int = 512, overlap: int = 16,
                 no_norm: bool = False) -> None:
    """Process a single audio file through the model.

    Args:
        model: Loaded EarVAE2 model.
        input_path: Path to input audio file.
        output_path: Path to save reconstructed audio.
        device: Torch device.
        chunk_size: Latent frames per chunk.
        overlap: Overlap frames between chunks.
        no_norm: Skip loudness normalization.
    """
    print(f"  Processing: {input_path}")

    # Load and convert to tensor
    audio_np = load_audio(input_path)
    original_length = audio_np.shape[-1]
    audio_tensor = torch.from_numpy(audio_np).unsqueeze(0).to(device)  # (1, 2, T)

    # Pad length up to a multiple of samples_per_latent (1920) for clean framing.
    spl = model.samples_per_latent
    pad_len = (-audio_tensor.shape[-1]) % spl
    if pad_len:
        audio_tensor = F.pad(audio_tensor, (0, pad_len))

    # Encode (chunked, deterministic)
    latents = model.encode_audio(
        audio_tensor, chunked=True,
        chunk_size=chunk_size, overlap=overlap,
        deterministic=True,
    )

    # Decode (chunked)
    reconstructed = model.decode_audio(
        latents, chunked=True,
        chunk_size=chunk_size, overlap=overlap,
    )

    # Trim to original length
    reconstructed = reconstructed[..., :original_length]

    # To numpy
    audio_out = reconstructed.squeeze(0).cpu().numpy()  # (2, T)

    # Clip to valid range
    audio_out = np.clip(audio_out, -1.0, 1.0)

    # Loudness normalization
    if not no_norm:
        audio_out = loudness_normalize(audio_out)

    save_audio(audio_out, output_path)
    print(f"  Saved: {output_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="EarVAE2 inference — reconstruct audio through the autoencoder.",
    )
    parser.add_argument(
        "--checkpoint", type=str, required=True,
        help="Path to model checkpoint (.pt or .pth).",
    )
    parser.add_argument(
        "--input", type=str, required=True,
        help="Input audio file or directory.",
    )
    parser.add_argument(
        "--output", type=str, required=True,
        help="Output audio file or directory.",
    )
    parser.add_argument(
        "--config", type=str, default=None,
        help="Path to model config JSON. Auto-detected if omitted.",
    )
    parser.add_argument(
        "--device", type=str, default="cuda:0",
        help="Torch device (default: cuda:0).",
    )
    parser.add_argument(
        "--chunk_size", type=int, default=512,
        help="Latent frames per chunk (default: 512).",
    )
    parser.add_argument(
        "--overlap", type=int, default=16,
        help="Overlap frames between chunks (default: 16).",
    )
    parser.add_argument(
        "--no_norm", action="store_true",
        help="Skip loudness normalization.",
    )
    args = parser.parse_args()

    # Deterministic inference
    set_deterministic()

    # Device
    if "cuda" in args.device and not torch.cuda.is_available():
        print("[WARN] CUDA not available, falling back to CPU.")
        args.device = "cpu"

    # Load model
    print(f"[INFO] Loading config...")
    config = load_config(args.config, args.checkpoint)
    print(f"[INFO] Model config: C0={config.get('C0', 64)}, D={config.get('D', 64)}, "
          f"use_vae={config.get('use_vae', True)}")

    print(f"[INFO] Loading checkpoint: {args.checkpoint}")
    model = load_model(args.checkpoint, config, args.device)
    print(f"[INFO] Model loaded on {args.device}.")

    # Determine input files
    input_path = Path(args.input)
    output_path = Path(args.output)

    audio_extensions = {".wav", ".mp3", ".flac"}

    if input_path.is_file():
        # Single file
        process_file(model, str(input_path), str(output_path),
                     args.device, args.chunk_size, args.overlap, args.no_norm)
    elif input_path.is_dir():
        # Directory of audio files
        output_path.mkdir(parents=True, exist_ok=True)
        files = []
        for ext in audio_extensions:
            files.extend(input_path.glob(f"*{ext}"))
            files.extend(input_path.glob(f"*{ext.upper()}"))

        if not files:
            print(f"[ERROR] No audio files found in {input_path}")
            return

        files = sorted(set(files))
        print(f"[INFO] Found {len(files)} audio file(s) in {input_path}")

        for audio_file in files:
            out_file = output_path / f"{audio_file.stem}.wav"
            process_file(model, str(audio_file), str(out_file),
                         args.device, args.chunk_size, args.overlap, args.no_norm)
    else:
        print(f"[ERROR] Input path does not exist: {input_path}")
        return

    print("[INFO] Done.")


if __name__ == "__main__":
    main()
