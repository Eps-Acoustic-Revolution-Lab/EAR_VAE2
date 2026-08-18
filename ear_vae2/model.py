"""
EarVAE2 — Spectral-domain stereo music autoencoder (inference-time definition).

The model operates on the complex STFT of 48 kHz stereo audio.  Each channel is
encoded independently through a shared 2-D convolutional stream, the two streams
are fused, collapsed along frequency and compressed by a 1-D bottleneck into a
continuous VAE latent.  The decoder mirrors this path and reconstructs the
per-channel complex spectrum, which is inverted back to a waveform via an
asymmetric STFT/iSTFT pair that guarantees drift-free reconstruction.

An optional band-aware Refiner post-processes the decoded spectrum with
perceptually-motivated magnitude/phase residuals and predicts the Nyquist bin.

STFT convention (fixed):
    n_fft = 960, hop_length = 480, win_length = 960
    samples_per_latent = 1920  (40 ms @ 48 kHz, 4x temporal downsampling)

This file is self-contained — it only depends on PyTorch.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.nn.utils.parametrizations import weight_norm


# ---------------------------------------------------------------------------
# STFT / iSTFT with asymmetric padding for drift-free reconstruction
# ---------------------------------------------------------------------------

def stft_center_false(x: torch.Tensor, n_fft: int, hop_length: int,
                      win_length: int, window: torch.Tensor) -> torch.Tensor:
    """Single-channel STFT with ``center=False`` and manual asymmetric padding.

    ``torch.stft(center=True)`` symmetrically pads ``n_fft // 2`` on both sides,
    which introduces a half-window temporal shift in the reconstructed phase.
    Here we left-pad ``n_fft // 2`` (to compensate the head trimmed by the
    paired ``istft(center=True)``) and right-pad ``hop_length // 2`` (to keep
    the frame count equal to ``signal_length / hop_length``).  Paired with
    :func:`istft_center_true` this yields length-aligned perfect reconstruction.

    Args:
        x: Single-channel waveform, shape ``(B, T)``.
        n_fft: FFT size.
        hop_length: Hop size in samples.
        win_length: Analysis window length.
        window: Window tensor of shape ``(win_length,)``.

    Returns:
        Complex STFT tensor of shape ``(B, n_fft // 2 + 1, num_frames)``.
    """
    pad_left = n_fft // 2
    pad_right = hop_length // 2
    x_padded = F.pad(x, (pad_left, pad_right), mode="constant", value=0)
    return torch.stft(
        x_padded, n_fft=n_fft, hop_length=hop_length, win_length=win_length,
        window=window, center=False, return_complex=True, onesided=True,
    )


def istft_center_true(X: torch.Tensor, n_fft: int, hop_length: int,
                      win_length: int, window: torch.Tensor,
                      original_length: int) -> torch.Tensor:
    """Inverse counterpart of :func:`stft_center_false`.

    ``torch.istft(center=True)`` trims ``n_fft // 2`` from the head after
    overlap-add.  Requesting ``length = original_length + hop_length // 2``
    makes the trimmed output start exactly at the original sample 0; the
    trailing ``hop_length // 2`` padding samples are then dropped manually.

    Args:
        X: Complex STFT tensor of shape ``(B, n_fft // 2 + 1, T)``.
        n_fft: FFT size (must match the forward call).
        hop_length: Hop size (must match the forward call).
        win_length: Window length (must match the forward call).
        window: Window tensor (must match the forward call).
        original_length: Length in samples of the original signal.

    Returns:
        Reconstructed waveform of shape ``(B, original_length)``.
    """
    pad_right = hop_length // 2
    istft_length = original_length + pad_right
    wav = torch.istft(
        X, n_fft=n_fft, hop_length=hop_length, win_length=win_length,
        window=window, center=True, length=istft_length, onesided=True,
    )
    return wav[:, :original_length]


# ---------------------------------------------------------------------------
# VAE reparameterisation
# ---------------------------------------------------------------------------

def vae_sample(mean: torch.Tensor, scale: torch.Tensor):
    """Reparameterised sampling with KL divergence against a unit Gaussian.

    Args:
        mean: Posterior mean, shape ``(B, D, T)``.
        scale: Raw scale parameter; std is ``softplus(scale)``.

    Returns:
        ``(z, kl)`` where *z* is the sampled latent and *kl* is the scalar
        KL divergence averaged over the batch.
    """
    stdev = F.softplus(scale)
    var = stdev * stdev + 1e-6
    logvar = torch.log(var)
    latents = torch.randn_like(mean) * stdev + mean
    kl = (mean * mean + var - logvar - 1).sum(1).mean()
    return latents, kl


# ---------------------------------------------------------------------------
# SnakeBeta activations
# ---------------------------------------------------------------------------

class SnakeBeta2d(nn.Module):
    """Frequency-bound SnakeBeta activation for spectrogram tensors ``[B, C, F, T]``.

    ``alpha`` / ``beta`` are learned per frequency bin (shared across channels
    by default), so each STFT bin — which maps to a fixed physical frequency —
    receives its own periodic-inductive bias.  Parameters are stored in
    log-scale for unconditional positivity.

    ``alpha`` is initialised from a log-frequency prior (higher bins start with
    a higher periodic response frequency); ``beta`` starts at zero (log-scale).
    """

    def __init__(self, in_channels: int, num_freq_bins: int | None = None,
                 alpha: float = 1.0, alpha_trainable: bool = True,
                 alpha_logscale: bool = True, shared_across_channels: bool = True):
        super().__init__()
        self.alpha_logscale = alpha_logscale
        self.shared = shared_across_channels
        self.eps = 1e-9
        self.num_freq_bins = num_freq_bins
        self.in_channels = in_channels
        self.alpha_trainable = alpha_trainable
        self._initialize_params(num_freq_bins)

    def freq_aware_init(self, num_freq_bins: int, sample_rate: int) -> torch.Tensor:
        """Log-frequency prior for ``alpha`` (log-scale)."""
        freqs = torch.linspace(0, sample_rate / 2, num_freq_bins + 1)
        freqs = freqs[:-1]  # drop the Nyquist bin to match the STFT layout
        return torch.log(freqs / freqs.mean() + 1e-6)

    def _initialize_params(self, num_freq_bins: int) -> None:
        param_shape = (num_freq_bins,) if self.shared else (self.in_channels, num_freq_bins)
        if self.alpha_logscale:
            self.alpha = nn.Parameter(self.freq_aware_init(num_freq_bins, 48000) * 1.0)
            self.beta = nn.Parameter(torch.zeros(*param_shape) * 1.0)
        else:
            self.alpha = nn.Parameter(torch.ones(*param_shape) * 1.0)
            self.beta = nn.Parameter(torch.ones(*param_shape) * 1.0)
        self.alpha.requires_grad = self.alpha_trainable
        self.beta.requires_grad = self.alpha_trainable

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: [B, C, F, T] -> [B, C, T, F]
        x = x.permute(0, 1, 3, 2)
        if self.shared:
            a = self.alpha.view(1, 1, -1, 1)
            b = self.beta.view(1, 1, -1, 1)
        else:
            a = self.alpha.unsqueeze(0).unsqueeze(-1)
            b = self.beta.unsqueeze(0).unsqueeze(-1)
        if self.alpha_logscale:
            a, b = torch.exp(a), torch.exp(b)
        x = x + (1.0 / (b + self.eps)) * torch.sin(x * a) ** 2
        return x.permute(0, 1, 3, 2)  # back to [B, C, F, T]


class SnakeBeta1d(nn.Module):
    """Per-channel SnakeBeta activation for 1-D feature maps ``[B, C, T]``.

    ``alpha`` / ``beta`` are learned per channel and stored in log-scale.
    """

    def __init__(self, in_features: int, alpha: float = 1.0,
                 alpha_trainable: bool = True, alpha_logscale: bool = True):
        super().__init__()
        self.in_features = in_features
        self.alpha_logscale = alpha_logscale
        if self.alpha_logscale:
            self.alpha = nn.Parameter(torch.zeros(in_features) * alpha)
            self.beta = nn.Parameter(torch.zeros(in_features) * alpha)
        else:
            self.alpha = nn.Parameter(torch.ones(in_features) * alpha)
            self.beta = nn.Parameter(torch.ones(in_features) * alpha)
        self.alpha.requires_grad = alpha_trainable
        self.beta.requires_grad = alpha_trainable
        self.no_div_by_zero = 1e-9

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        alpha = self.alpha.unsqueeze(0).unsqueeze(-1)
        beta = self.beta.unsqueeze(0).unsqueeze(-1)
        if self.alpha_logscale:
            alpha = torch.exp(alpha)
            beta = torch.exp(beta)
        return x + (1.0 / (beta + self.no_div_by_zero)) * torch.sin(x * alpha) ** 2


def _make_act(act_fn: str, out_channels: int, num_freq_bins: int | None):
    if act_fn == "snake":
        return SnakeBeta2d(out_channels, num_freq_bins=num_freq_bins)
    if act_fn == "silu":
        return nn.SiLU()
    if act_fn == "gelu":
        return nn.GELU()
    raise ValueError(f"Unknown activation {act_fn}")


# ---------------------------------------------------------------------------
# Non-causal 2-D encoder / decoder blocks
# ---------------------------------------------------------------------------

class EncoderBlock(nn.Module):
    """Non-causal residual encoder block with symmetric padding.

    Two convolutions (a 3x3 feature conv followed by a strided conv that
    changes channel count and downsamples frequency/time) with a projected,
    average-pooled shortcut.  Pre-activation with :class:`SnakeBeta2d`.
    """

    def __init__(self, in_channels: int, out_channels: int, stride=(1, 1),
                 num_freq_bins: int | None = None, act_fn: str = "snake"):
        super().__init__()
        self.act = _make_act(act_fn, out_channels, num_freq_bins)
        time_stride, freq_stride = stride

        self.conv1 = weight_norm(nn.Conv2d(in_channels, in_channels, kernel_size=3))

        def get_kernel_and_padding(s):
            k = max(3, 2 * s)
            pad = (k - s) // 2
            return k, pad

        kernel_size_t, _ = get_kernel_and_padding(time_stride)
        kernel_size_f, _ = get_kernel_and_padding(freq_stride)
        self.conv2 = weight_norm(nn.Conv2d(
            in_channels, out_channels,
            kernel_size=(kernel_size_t, kernel_size_f), stride=stride))

        self.has_shortcut = (in_channels != out_channels) or (time_stride != 1) or (freq_stride != 1)
        if self.has_shortcut:
            self.projection = weight_norm(nn.Conv2d(in_channels, out_channels, kernel_size=1))
            if time_stride > 1 or freq_stride > 1:
                self.avg_pool = nn.AvgPool2d(kernel_size=stride, stride=stride)
            else:
                self.avg_pool = nn.Identity()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, C, Time, Freq)
        shortcut = x
        if self.has_shortcut:
            shortcut = self.projection(self.avg_pool(shortcut))

        x = self.act(x)
        x = F.pad(x, (1, 1, 1, 1))
        x = self.conv1(x)

        k_t = self.conv2.kernel_size[0]
        k_f = self.conv2.kernel_size[1]
        s_t = self.conv2.stride[0]
        pad_f = (k_f - 1) // 2
        pad_t = k_t - s_t
        pad_t_before = pad_t // 2
        pad_t_after = pad_t - pad_t_before

        x = self.act(x)
        x = F.pad(x, (pad_f, pad_f, pad_t_before, pad_t_after))
        x = self.conv2(x)
        return x + shortcut


class DecoderBlock(nn.Module):
    """Non-causal residual decoder block with symmetric padding.

    A 3x3 feature conv followed by a transposed conv that upsamples
    frequency/time, with a nearest-upsampled, projected shortcut.
    """

    def __init__(self, in_channels: int, out_channels: int, stride=(1, 1),
                 num_freq_bins: int | None = None, act_fn: str = "snake"):
        super().__init__()
        self.act = _make_act(act_fn, out_channels, num_freq_bins)
        time_stride, freq_stride = stride

        self.conv1 = weight_norm(nn.Conv2d(in_channels, out_channels, kernel_size=3))

        def get_kernel_and_padding(s):
            k = max(3, 2 * s)
            pad = (k - s) // 2
            return k, pad

        kernel_size_t, padding_t = get_kernel_and_padding(time_stride)
        kernel_size_f, padding_f = get_kernel_and_padding(freq_stride)
        self.transposed_conv = weight_norm(nn.ConvTranspose2d(
            out_channels, out_channels,
            kernel_size=(kernel_size_t, kernel_size_f),
            padding=(padding_t, padding_f), stride=stride))

        self.has_shortcut = (in_channels != out_channels) or (time_stride != 1) or (freq_stride != 1)
        if self.has_shortcut:
            self.projection = weight_norm(nn.Conv2d(in_channels, out_channels, kernel_size=1))
            if time_stride > 1 or freq_stride > 1:
                self.upsample = nn.Upsample(scale_factor=stride, mode="nearest")
            else:
                self.upsample = nn.Identity()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        shortcut = x
        if self.has_shortcut:
            shortcut = self.projection(self.upsample(shortcut))

        x = self.act(x)
        x = F.pad(x, (1, 1, 1, 1))
        x = self.conv1(x)

        x = self.act(x)
        x = self.transposed_conv(x)

        # Guard against off-by-one size drift from the transposed conv.
        if x.shape[2] != shortcut.shape[2]:
            diff_t = x.shape[2] - shortcut.shape[2]
            start_t = diff_t // 2
            x = x[:, :, start_t:start_t + shortcut.shape[2], :]
        if x.shape[3] != shortcut.shape[3]:
            diff_f = x.shape[3] - shortcut.shape[3]
            start_f = diff_f // 2
            x = x[:, :, :, start_f:start_f + shortcut.shape[3]]
        return x + shortcut


class Bottleneck1D(nn.Module):
    """1-D residual bottleneck: two 1x1 convs with SnakeBeta1d activations."""

    def __init__(self, in_channels: int, out_channels: int):
        super().__init__()
        intermediate_channels = max(in_channels, out_channels)
        self.act = SnakeBeta1d(in_channels)
        self.conv1 = weight_norm(nn.Conv1d(in_channels, intermediate_channels, kernel_size=1))
        self.act2 = SnakeBeta1d(intermediate_channels)
        self.conv2 = weight_norm(nn.Conv1d(intermediate_channels, out_channels, kernel_size=1))
        self.shortcut = nn.Identity()
        if in_channels != out_channels:
            self.shortcut = weight_norm(nn.Conv1d(in_channels, out_channels, kernel_size=1))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        shortcut = self.shortcut(x)
        x = self.act(x)
        x = self.conv1(x)
        x = self.act2(x)
        x = self.conv2(x)
        return x + shortcut


# ---------------------------------------------------------------------------
# Encoder / Decoder
# ---------------------------------------------------------------------------

class SpecEncoder(nn.Module):
    """Non-causal spectral encoder.

    Runs each stereo channel's STFT ``(B, 2, T, F)`` through a shared 2-D block
    stream, concatenates the two streams on the channel axis, fuses them, then
    flattens frequency into channels and compresses to a ``(B, D, T')`` latent.
    """

    def __init__(self, C0: int = 32, D: int = 256, n_fft: int = 960, act_fn: str = "snake"):
        super().__init__()
        self.C0 = C0
        self.D = D
        self.raw_num_freq_bins = n_fft // 2  # 480
        self.act_fn = act_fn

        self.input_conv = weight_norm(nn.Conv2d(2, C0, kernel_size=(7, 7)))

        rb = self.raw_num_freq_bins
        # (in_mult, out_mult, stride, freq_div): channels are C0 * mult, and the
        # activation tracks rb // freq_div bins at that block's input.
        encoder_specs = [
            (1, 2, (1, 2), 1),
            (2, 2, (1, 2), 2),
            (2, 4, (1, 3), 4),
            (4, 4, (1, 2), 12),
            (4, 4, (1, 2), 24),
            (4, 8, (2, 2), 48),
            (8, 8, (2, 1), 96),
        ]
        self.encoder_stream = nn.ModuleList([
            EncoderBlock(im * C0, om * C0, stride=st, num_freq_bins=rb // fd, act_fn=act_fn)
            for im, om, st, fd in encoder_specs
        ])

        self.post_concat_block = EncoderBlock(
            16 * C0, 8 * C0, stride=(1, 1), num_freq_bins=rb // 96, act_fn=act_fn)

        # Frequency axis (5 bins) is flattened into channels: 8*C0 * 5 = 40*C0.
        self.bottleneck_block = Bottleneck1D(40 * C0, D)

    def _run_stream(self, x_ch: torch.Tensor) -> torch.Tensor:
        x_ch = F.pad(x_ch, (3, 3, 3, 3))  # symmetric pad for the k=7 input conv
        z = self.input_conv(x_ch)
        for block in self.encoder_stream:
            z = block(z)
        return z

    def forward(self, x_left_ch: torch.Tensor, x_right_ch: torch.Tensor) -> torch.Tensor:
        z_left = self._run_stream(x_left_ch)
        z_right = self._run_stream(x_right_ch)
        z = torch.cat([z_left, z_right], dim=1)          # (B, 16*C0, T', F')
        z = self.post_concat_block(z)                    # (B, 8*C0,  T', F')
        B, C, T_out, F_out = z.shape
        z = z.permute(0, 2, 1, 3).reshape(B, T_out, C * F_out)
        z = z.permute(0, 2, 1)                           # (B, 40*C0, T')
        return self.bottleneck_block(z)                  # (B, D, T')


class SpecDecoder(nn.Module):
    """Non-causal spectral decoder — the inverse of :class:`SpecEncoder`."""

    def __init__(self, C0: int = 32, D: int = 128, n_fft: int = 960, act_fn: str = "snake"):
        super().__init__()
        self.C0 = C0
        self.D = D
        self.raw_num_freq_bins = n_fft // 2
        self.act_fn = act_fn

        self.bottleneck_block = Bottleneck1D(D, 40 * C0)
        self.pre_split_block = DecoderBlock(
            8 * C0, 16 * C0, stride=(1, 1), num_freq_bins=self.raw_num_freq_bins // 96, act_fn=act_fn)

        rb = self.raw_num_freq_bins
        # Mirror of the encoder stream (see :class:`SpecEncoder`), reversed.
        # (in_mult, out_mult, stride, freq_div): channels are C0 * mult.
        decoder_specs = [
            (8, 8, (2, 1), 96),
            (8, 4, (2, 2), 96),
            (4, 4, (1, 2), 48),
            (4, 4, (1, 2), 24),
            (4, 2, (1, 3), 12),
            (2, 2, (1, 2), 4),
            (2, 1, (1, 2), 2),
        ]
        self.decoder_stream = nn.ModuleList([
            DecoderBlock(im * C0, om * C0, stride=st, num_freq_bins=rb // fd, act_fn=act_fn)
            for im, om, st, fd in decoder_specs
        ])

        self.output_conv = weight_norm(nn.Conv2d(C0, 2, kernel_size=(7, 7)))

    def forward(self, embedding: torch.Tensor):
        z = self.bottleneck_block(embedding)             # (B, 40*C0, T')
        B, _, T_out = z.shape
        z = z.permute(0, 2, 1).reshape(B, T_out, 8 * self.C0, 5)
        z = z.permute(0, 2, 1, 3)                        # (B, 8*C0, T', 5)
        z = self.pre_split_block(z)                      # (B, 16*C0, T', 5)

        z_left, z_right = torch.chunk(z, 2, dim=1)       # each (B, 8*C0, T', 5)
        for block in self.decoder_stream:
            z_left = block(z_left)
            z_right = block(z_right)

        out_left = F.pad(z_left, (3, 3, 3, 3))
        out_right = F.pad(z_right, (3, 3, 3, 3))
        return self.output_conv(out_left), self.output_conv(out_right)


# ---------------------------------------------------------------------------
# Band-aware Refiner
# ---------------------------------------------------------------------------

_SAMPLE_RATE_HZ = 48_000
_SPLIT_LOW_HZ = 1500.0
_SPLIT_HIGH_HZ = 4000.0


def _band_splits_from_input_bins(input_freq_bins: int):
    """Map physical split frequencies (1.5 kHz / 4 kHz) to bin indices.

    Returns ``(n_fft, split_low, split_high)`` defining three bands:
    ``[0, split_low)``, ``[split_low, split_high)``, ``[split_high, F)``.
    """
    F_bins = input_freq_bins
    n_fft = 2 * F_bins
    sr = float(_SAMPLE_RATE_HZ)
    split_low = int(round(_SPLIT_LOW_HZ * n_fft / sr))
    split_high = int(round(_SPLIT_HIGH_HZ * n_fft / sr))
    split_low = max(1, min(split_low, F_bins - 2))
    split_high = max(split_low + 1, min(split_high, F_bins - 1))
    return n_fft, split_low, split_high


class ConvNeXtBlock(nn.Module):
    """1-D ConvNeXt block: depthwise conv + LayerNorm + pointwise MLP + LayerScale."""

    def __init__(self, dim: int, intermediate_dim: int, layer_scale_init_value: float):
        super().__init__()
        self.dwconv = nn.Conv1d(dim, dim, kernel_size=7, padding=3, groups=dim)
        self.norm = nn.LayerNorm(dim, eps=1e-6)
        self.pwconv1 = nn.Linear(dim, intermediate_dim)
        self.act = nn.GELU()
        self.pwconv2 = nn.Linear(intermediate_dim, dim)
        self.gamma = (
            nn.Parameter(layer_scale_init_value * torch.ones(dim), requires_grad=True)
            if layer_scale_init_value > 0 else None
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = x
        x = self.dwconv(x)
        x = x.transpose(1, 2)        # (B, T, C)
        x = self.norm(x)
        x = self.pwconv1(x)
        x = self.act(x)
        x = self.pwconv2(x)
        if self.gamma is not None:
            x = self.gamma * x
        x = x.transpose(1, 2)        # (B, C, T)
        return residual + x


class SpecRefinerBanded(nn.Module):
    """Band-aware magnitude/phase Refiner over the decoded complex spectrum.

    A 1-D ConvNeXt backbone predicts residuals interpreted per band:

    - **Low** ``[0, split_low)``: phase-only residual — preserves inter-aural
      time-difference cues while allowing fine phase correction.
    - **Mid** ``[split_low, split_high)``: magnitude + phase residual — full
      correction in the perceptually most sensitive band.
    - **High** ``[split_high, F)``: magnitude-only residual — preserves
      inter-aural level-difference cues while correcting the spectral envelope.

    It additionally predicts the Nyquist bin, so the input ``(B, F, T)``
    (no Nyquist) maps to ``(B, F + 1, T)`` ready for iSTFT.

    Args:
        input_freq_bins: Number of input bins (``n_fft // 2``, no Nyquist).
        dim: Backbone feature dimension.
        intermediate_dim: MLP hidden dimension inside ConvNeXt blocks.
        num_layers: Number of ConvNeXt blocks.
        layer_scale_init_value: LayerScale init; defaults to ``1 / num_layers``.
        layer_norm_eps: LayerNorm epsilon.
    """

    def __init__(self, input_freq_bins: int = 480, dim: int = 256,
                 intermediate_dim: int = 768, num_layers: int = 6,
                 layer_scale_init_value: float | None = None,
                 layer_norm_eps: float = 1e-6):
        super().__init__()
        self.input_freq_bins = input_freq_bins
        _, split_low, split_high = _band_splits_from_input_bins(input_freq_bins)
        self.split_low = split_low
        self.split_high = split_high

        F_bins = input_freq_bins
        sl, sh = split_low, split_high
        mid = sh - sl
        out_features = sl + 2 * mid + (F_bins - sh) + 2
        input_channels = F_bins * 2
        layer_scale_init_value = layer_scale_init_value or (1.0 / num_layers)

        self.embed = nn.Conv1d(input_channels, dim, kernel_size=7, padding=3)
        self.norm = nn.LayerNorm(dim, eps=layer_norm_eps)
        self.convnext = nn.ModuleList([
            ConvNeXtBlock(dim, intermediate_dim, layer_scale_init_value)
            for _ in range(num_layers)
        ])
        self.final_norm = nn.LayerNorm(dim, eps=layer_norm_eps)
        self.out = nn.Linear(dim, out_features)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Refine ``(B, F, T)`` complex spectrum into ``(B, F + 1, T)``."""
        F_bins = self.input_freq_bins
        sl, sh = self.split_low, self.split_high

        h = torch.cat([x.real, x.imag], dim=1)            # (B, 2F, T)
        h = self.embed(h)
        h = self.norm(h.transpose(1, 2)).transpose(1, 2)
        for block in self.convnext:
            h = block(h)
        h = self.final_norm(h.transpose(1, 2))            # (B, T, dim)
        o = self.out(h).transpose(1, 2)                   # (B, out_features, T)

        mid = sh - sl
        o_low = o[:, :sl, :]
        dM_mid = o[:, sl:sl + mid, :]
        dphi_mid = o[:, sl + mid:sl + 2 * mid, :]
        o_high = o[:, sl + 2 * mid:sl + 2 * mid + (F_bins - sh), :]
        nyq_real = o[:, -2:-1, :]
        nyq_imag = o[:, -1:, :]

        M = torch.abs(x)
        P = torch.angle(x)
        eps = 1e-8

        refined = torch.empty_like(x)
        # Low: phase-only.
        refined[:, :sl] = torch.polar(M[:, :sl], P[:, :sl] + o_low)
        # High: magnitude-only.
        M_hi = torch.clamp(M[:, sh:] + o_high, min=eps)
        refined[:, sh:] = torch.polar(M_hi, P[:, sh:])
        # Mid: magnitude + phase.
        M_mid = torch.clamp(M[:, sl:sh] + dM_mid, min=eps)
        refined[:, sl:sh] = torch.polar(M_mid, P[:, sl:sh] + dphi_mid)

        nyquist = torch.complex(nyq_real, nyq_imag)
        return torch.cat([refined, nyquist], dim=1)


# ---------------------------------------------------------------------------
# Main model
# ---------------------------------------------------------------------------

class EarVAE2(nn.Module):
    """EarVAE2 — spectral-domain stereo music variational autoencoder.

    Args:
        config: Dictionary with keys:

            - ``C0`` (int): Base channel count.  The encoder uses ``C0``;
              the decoder uses ``2 * C0`` unless ``C0_decoder`` is given.
            - ``D`` (int): Latent dimensionality.
            - ``use_vae`` (bool): Enable VAE mode (encoder emits mean + scale).
            - ``act_fn`` (str): ``"snake"`` (default), ``"silu"`` or ``"gelu"``.
            - ``C0_encoder`` / ``C0_decoder`` (int, optional): Override the
              per-side channel counts.
            - ``refiner`` (dict, optional): Band-aware Refiner config with keys
              ``type`` (``"banded"``), ``dim``, ``intermediate_dim``,
              ``num_layers``, ``layer_norm_eps``.

    Example::

        config = {
            "C0": 64, "D": 128, "use_vae": True,
            "refiner": {"type": "banded", "dim": 256,
                        "intermediate_dim": 1024, "num_layers": 12,
                        "layer_norm_eps": 1e-5},
        }
        model = EarVAE2(config)
    """

    def __init__(self, config: dict | None = None):
        super().__init__()
        config = config or {}
        C0 = config.get("C0", 32)
        D = config.get("D", 128)
        C0_encoder = config.get("C0_encoder", C0)
        C0_decoder = config.get("C0_decoder", C0 * 2)
        self.use_vae = config.get("use_vae", False)
        self.act_fn = config.get("act_fn", "snake")

        # STFT parameters (fixed).
        self.hop_length = 480
        self.win_length = 960
        self.n_fft = 960
        self.register_buffer("window", torch.hann_window(self.win_length))

        enc_out = 2 * D if self.use_vae else D
        self.encoder = SpecEncoder(C0_encoder, enc_out, self.n_fft, self.act_fn)
        self.decoder = SpecDecoder(C0_decoder, D, self.n_fft, self.act_fn)

        refiner_cfg = config.get("refiner", None)
        if refiner_cfg is not None:
            refiner_cfg = dict(refiner_cfg)
            refiner_cfg.pop("type", None)
            self.refiner = SpecRefinerBanded(input_freq_bins=self.n_fft // 2, **refiner_cfg)
        else:
            self.refiner = None

        # A second window buffer is kept for spectral compatibility with the
        # Refiner path (identical to ``window`` at n_fft=960).
        self.register_buffer("refiner_window", torch.hann_window(self.win_length))

        self.encoder_time_downsampling = 4
        self.samples_per_latent = self.hop_length * self.encoder_time_downsampling  # 1920

    # ----- STFT helpers ---------------------------------------------------

    @staticmethod
    def _to_channels(s: torch.Tensor) -> torch.Tensor:
        # (B, F, T) complex -> (B, 2, T, F) real
        s_ch = torch.stack([s.real, s.imag], dim=1)
        return s_ch.permute(0, 1, 3, 2)

    @staticmethod
    def _to_complex(s_ch: torch.Tensor) -> torch.Tensor:
        # (B, 2, T, F) real -> (B, F, T) complex
        s = s_ch.permute(0, 2, 3, 1)
        return torch.complex(s[..., 0], s[..., 1]).permute(0, 2, 1)

    def _istft(self, X: torch.Tensor, original_length: int) -> torch.Tensor:
        return istft_center_true(
            X, self.n_fft, self.hop_length, self.win_length, self.window, original_length)

    def _refine_or_pad(self, spec_complex: torch.Tensor) -> torch.Tensor:
        if self.refiner is not None:
            return self.refiner(spec_complex)
        return F.pad(spec_complex, (0, 0, 0, 1))  # append zero Nyquist bin

    # ----- core forward ---------------------------------------------------

    def forward(self, x: torch.Tensor, return_spec: bool = False):
        """Full encode -> sample -> decode pipeline.

        Args:
            x: Stereo waveform ``(B, 2, T)`` at 48 kHz.

        Returns:
            ``(reconstruction, kl)`` where *kl* is ``None`` in non-VAE mode.
        """
        original_length = x.shape[-1]
        x_left = stft_center_false(x[:, 0], self.n_fft, self.hop_length, self.win_length, self.window)
        x_right = stft_center_false(x[:, 1], self.n_fft, self.hop_length, self.win_length, self.window)
        x_left = x_left[:, :-1, :]   # drop Nyquist
        x_right = x_right[:, :-1, :]

        embedding = self.encoder(self._to_channels(x_left), self._to_channels(x_right))

        if self.use_vae:
            mean, scale = torch.chunk(embedding, 2, dim=1)
            z, kl = vae_sample(mean, scale)
        else:
            z, kl = embedding, None

        out_left_ch, out_right_ch = self.decoder(z)
        out_left = self._refine_or_pad(self._to_complex(out_left_ch))
        out_right = self._refine_or_pad(self._to_complex(out_right_ch))

        if return_spec:
            return (out_left, out_right), kl

        out_left_wav = self._istft(out_left, original_length)
        out_right_wav = self._istft(out_right, original_length)
        out_wav = torch.stack([out_left_wav, out_right_wav], dim=1)
        return out_wav, kl

    # ----- encode ---------------------------------------------------------

    def encode(self, x: torch.Tensor, deterministic: bool = False) -> torch.Tensor:
        """Encode a stereo waveform ``(B, 2, T)`` to a latent ``(B, D, T')``."""
        x_left = stft_center_false(x[:, 0], self.n_fft, self.hop_length, self.win_length, self.window)
        x_right = stft_center_false(x[:, 1], self.n_fft, self.hop_length, self.win_length, self.window)
        x_left = x_left[:, :-1, :]
        x_right = x_right[:, :-1, :]

        embedding = self.encoder(self._to_channels(x_left), self._to_channels(x_right))
        if self.use_vae:
            mean, scale = torch.chunk(embedding, 2, dim=1)
            if deterministic:
                return mean
            z, _ = vae_sample(mean, scale)
            return z
        return embedding

    def encode_audio(self, audio: torch.Tensor, chunked: bool = False,
                     overlap: int = 32, chunk_size: int = 128,
                     deterministic: bool = False) -> torch.Tensor:
        """Encode with optional chunked processing for long audio.

        Args:
            audio: Waveform ``(B, 2, T)`` at 48 kHz; ``T`` should be a multiple
                of ``samples_per_latent`` (1920).
            chunked: Enable chunked encoding to bound peak memory.
            overlap: Overlapping latent frames between chunks.
            chunk_size: Latent frames per chunk.
            deterministic: Return the posterior mean (no sampling noise).

        Returns:
            Latent tensor ``(B, D, T')`` with ``T' = T // samples_per_latent``.
        """
        if not chunked:
            return self.encode(audio, deterministic=deterministic)

        spl = self.samples_per_latent
        total_size = audio.shape[2]
        batch_size = audio.shape[0]

        chunk_size_samples = chunk_size * spl
        overlap_samples = overlap * spl
        hop_size_samples = chunk_size_samples - overlap_samples

        chunks = []
        i = 0
        for i in range(0, total_size - chunk_size_samples + 1, hop_size_samples):
            chunks.append(audio[:, :, i:i + chunk_size_samples])
        if len(chunks) == 0 or i + chunk_size_samples != total_size:
            chunks.append(audio[:, :, -chunk_size_samples:])
        num_chunks = len(chunks)

        latent_dim = self.encoder.D // 2 if self.use_vae else self.encoder.D
        y_size = total_size // spl
        y_final = torch.zeros((batch_size, latent_dim, y_size),
                              device=audio.device, dtype=audio.dtype)

        for idx in range(num_chunks):
            y_chunk = self.encode(chunks[idx], deterministic=deterministic)
            if idx == num_chunks - 1:
                t_end = y_size
                t_start = t_end - y_chunk.shape[2]
            else:
                t_start = idx * hop_size_samples // spl
                t_end = t_start + chunk_size

            ol = overlap // 2
            chunk_start = 0
            chunk_end = y_chunk.shape[2]
            if idx > 0:
                t_start += ol
                chunk_start += ol
            if idx < num_chunks - 1:
                t_end -= ol
                chunk_end -= ol
            y_final[:, :, t_start:t_end] = y_chunk[:, :, chunk_start:chunk_end]

        return y_final

    # ----- decode ---------------------------------------------------------

    def decode(self, embedding: torch.Tensor, original_length: int) -> torch.Tensor:
        """Decode a latent ``(B, D, T')`` back to a waveform ``(B, 2, T)``."""
        out_left_ch, out_right_ch = self.decoder(embedding)
        out_left = self._refine_or_pad(self._to_complex(out_left_ch))
        out_right = self._refine_or_pad(self._to_complex(out_right_ch))
        out_left_wav = self._istft(out_left, original_length)
        out_right_wav = self._istft(out_right, original_length)
        return torch.stack([out_left_wav, out_right_wav], dim=1)

    def decode_audio(self, latents: torch.Tensor, chunked: bool = False,
                     overlap: int = 32, chunk_size: int = 128) -> torch.Tensor:
        """Decode with optional chunked processing for long latent sequences.

        Args:
            latents: Latent ``(B, D, T')``.
            chunked: Enable chunked decoding.
            overlap: Overlapping latent frames between chunks.
            chunk_size: Latent frames per chunk.

        Returns:
            Waveform ``(B, 2, T)`` with ``T = T' * samples_per_latent``.
        """
        spl = self.samples_per_latent
        total_latent_size = latents.shape[2]
        total_audio_size = total_latent_size * spl

        if not chunked:
            return self.decode(latents, original_length=total_audio_size)

        batch_size = latents.shape[0]
        hop_size = chunk_size - overlap

        chunks = []
        i = 0
        for i in range(0, total_latent_size - chunk_size + 1, hop_size):
            chunks.append(latents[:, :, i:i + chunk_size])
        if len(chunks) == 0 or i + chunk_size != total_latent_size:
            chunks.append(latents[:, :, -chunk_size:])
        num_chunks = len(chunks)

        y_final = torch.zeros((batch_size, 2, total_audio_size),
                              device=latents.device, dtype=latents.dtype)

        for idx in range(num_chunks):
            x_chunk = chunks[idx]
            chunk_audio_length = x_chunk.shape[2] * spl
            y_chunk = self.decode(x_chunk, original_length=chunk_audio_length)

            if idx == num_chunks - 1:
                t_end = total_audio_size
                t_start = t_end - y_chunk.shape[2]
            else:
                t_start = idx * hop_size * spl
                t_end = t_start + chunk_size * spl

            ol = (overlap // 2) * spl
            chunk_start = 0
            chunk_end = y_chunk.shape[2]
            if idx > 0:
                t_start += ol
                chunk_start += ol
            if idx < num_chunks - 1:
                t_end -= ol
                chunk_end -= ol
            y_final[:, :, t_start:t_end] = y_chunk[:, :, chunk_start:chunk_end]

        return y_final

    # ----- utilities ------------------------------------------------------

    def preprocess_audio(self, audio: torch.Tensor):
        """Right-pad the waveform length to a multiple of ``samples_per_latent``.

        Returns ``(padded_audio, original_length)``.
        """
        original_length = audio.shape[-1]
        if original_length == 0:
            raise ValueError("audio must have at least one sample (T > 0)")
        spl = self.samples_per_latent
        remainder = original_length % spl
        if remainder == 0:
            return audio, original_length
        pad_len = spl - remainder
        padded = F.pad(audio, (0, pad_len), mode="constant", value=0.0)
        return padded, original_length
