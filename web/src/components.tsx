import { useRef, useState } from 'react';
import { playability, type CodecFamily, type VideoProbe } from '../../shared/mp4-probe.ts';
import type { VideoDto } from '../../shared/types.ts';
import { formatDuration, formatTimecode } from './format.ts';

const CODEC_LABELS: Record<CodecFamily, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  other: 'Other codec',
};

// Representative codec strings to ask this browser whether it can decode the family.
const CODEC_PROBES: Partial<Record<CodecFamily, string>> = {
  hevc: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
  av1: 'video/mp4; codecs="av01.0.08M.08"',
  vp9: 'video/mp4; codecs="vp09.00.10.08"',
};

function playsInThisBrowser(family: CodecFamily): boolean | null {
  const type = CODEC_PROBES[family];
  return type ? document.createElement('video').canPlayType(type) !== '' : null;
}

/** Codec plus whether it will play: everywhere, in some browsers (and this one?), or not at all. */
export function CodecBadge({ probe }: { probe: VideoProbe | null }) {
  const level = playability(probe);
  const family = probe?.codecFamily;
  if (!family) {
    return (
      <span className="badge badge-unsupported" title="Not an MP4/MOV video we could read">
        Unknown format
      </span>
    );
  }
  if (level === 'ok') {
    return (
      <span className="badge badge-ok" title="Plays in all current browsers">
        {CODEC_LABELS[family]}
      </span>
    );
  }
  if (level === 'unsupported') {
    return (
      <span className="badge badge-unsupported" title="Browsers will most likely not play this; convert to H.264 MP4">
        {CODEC_LABELS[family]} · won’t play
      </span>
    );
  }
  const here = playsInThisBrowser(family);
  return (
    <span
      className="badge badge-limited"
      title="Plays in Safari, and in Chrome/Edge/Firefox only with hardware support. Viewers on other devices may see nothing."
    >
      {CODEC_LABELS[family]} · {here ? 'plays here, not everywhere' : 'not in this browser'}
    </span>
  );
}

export function probeSummary(probe: VideoProbe | null): string {
  if (!probe) return '';
  const parts: string[] = [];
  if (probe.width && probe.height) parts.push(`${probe.width}×${probe.height}`);
  if (probe.fps) parts.push(`${probe.fps} fps${probe.variableFrameRate ? ' (variable)' : ''}`);
  if (probe.durationSec) parts.push(formatDuration(probe.durationSec));
  return parts.join(' · ');
}

/** Playable length after trimming, when the file's duration is known. */
export function effectiveDurationSec(video: VideoDto): number | null {
  const full = video.probe?.durationSec ?? null;
  const end = video.trimEndSec ?? full;
  return end === null ? null : Math.max(0, end - (video.trimStartSec ?? 0));
}

/** e.g. "rotated 90° · plays 0:12.3–1:20:00.0"; null when unedited. */
export function editSummary(video: VideoDto): string | null {
  const parts: string[] = [];
  if (video.rotation !== 0) parts.push(`rotated ${video.rotation}°`);
  if (video.trimStartSec !== null || video.trimEndSec !== null) {
    const from = formatTimecode(video.trimStartSec ?? 0);
    const to = video.trimEndSec !== null ? formatTimecode(video.trimEndSec) : 'end';
    parts.push(`plays ${from}–${to}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Warnings that affect playback or frame stepping later on. */
export function probeWarnings(probe: VideoProbe | null, probeError?: string | null): string[] {
  if (!probe) return [probeError ? `Could not read file details: ${probeError}` : 'Could not read file details'];
  const warnings: string[] = [];
  if (!probe.faststart) warnings.push('Index at the end of the file: playback starts a little slower');
  if (probe.variableFrameRate) warnings.push('Variable frame rate: frame stepping will be approximate');
  if (probe.fragmented) warnings.push('Fragmented MP4: seeking may be limited');
  if (!probe.audioCodec) warnings.push('No audio track');
  return warnings;
}

/** Text with a rename button; Enter saves, Escape cancels. */
export function EditableText({
  value,
  onSave,
  label,
  maxLength = 255,
}: {
  value: string;
  onSave: (value: string) => Promise<void>;
  label: string;
  maxLength?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Enter or Escape ends editing; the blur that follows must not save a second time.
  const finished = useRef(false);

  if (draft === null) {
    const start = () => {
      finished.current = false;
      setDraft(value);
    };
    return (
      <span className="editable">
        <span>{value}</span>
        <button className="icon" onClick={start} aria-label={`Rename ${label}`} title="Rename">
          ✎
        </button>
      </span>
    );
  }

  const cancel = () => {
    finished.current = true;
    setDraft(null);
  };

  const save = async () => {
    if (finished.current) return;
    finished.current = true;
    const next = draft.trim();
    if (!next || next === value) {
      setDraft(null);
      return;
    }
    try {
      await onSave(next);
      setDraft(null);
      setError(null);
    } catch (err) {
      finished.current = false;
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <span className="editable editing">
      <input
        autoFocus
        value={draft}
        maxLength={maxLength}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') cancel();
        }}
        onBlur={() => void save()}
      />
      {error && <span className="error small">{error}</span>}
    </span>
  );
}
