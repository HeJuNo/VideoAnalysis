// Profile editor: event types, attributes and click diagrams, with a live preview of what taggers
// and analysts will see. Saving a changed definition creates a new version on the server.
import { useEffect, useState, type ChangeEvent, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import {
  ATTRIBUTE_TYPES,
  attributesFor,
  DIAGRAM_TEMPLATES,
  diagramsFor,
  EVENT_KINDS,
  HOTKEY_PATTERN,
  isPointKind,
  keyFromLabel,
  missingStandardMarkers,
  type AttributeDef,
  type AttributeType,
  type DiagramDef,
  type DiagramTemplate,
  type EventKind,
  type EventTypeDef,
  type OptionDef,
  type ProfileDefinition,
} from '../../../shared/profile.ts';
import type { ProfileDto, UserDto } from '../../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { DiagramPicker, type DiagramPoint } from '../diagrams/DiagramPicker.tsx';
import { formatDate } from '../format.ts';
import { href, navigate } from '../router.ts';
import { AttributeField, type AttributeValue } from './AttributeField.tsx';
import { uploadImage } from './uploadImage.ts';

const PALETTE = ['#1a7f37', '#c8102e', '#1f6feb', '#8250df', '#9a6700', '#0e7490', '#be185d', '#4b5563'];

type Update = (fn: (def: ProfileDefinition) => ProfileDefinition) => void;

const hasOptions = (type: AttributeType) => ATTRIBUTE_TYPES.find((t) => t.type === type)!.hasOptions;

function move<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function replaceAt<T>(list: T[], index: number, item: T): T[] {
  return list.map((existing, i) => (i === index ? item : existing));
}

/** Problems worth fixing before saving; the server checks the same and more. */
function findProblems(def: ProfileDefinition, name: string, sport: string): string[] {
  const problems: string[] = [];
  if (!name.trim()) problems.push('The profile needs a name.');
  if (!sport.trim()) problems.push('The profile needs a sport.');
  if (def.eventTypes.length === 0) problems.push('Add at least one event type.');
  const hotkeys = new Set<string>();
  for (const e of def.eventTypes) {
    if (!e.label.trim()) problems.push('An event type has no name.');
    if (e.hotkey && !HOTKEY_PATTERN.test(e.hotkey)) problems.push(`Hotkey "${e.hotkey}" must be a letter or digit.`);
    if (e.hotkey && hotkeys.has(e.hotkey)) problems.push(`Hotkey "${e.hotkey.toUpperCase()}" is used twice.`);
    if (e.hotkey) hotkeys.add(e.hotkey);
  }
  for (const kind of ['period-start', 'period-end'] as const) {
    if (def.eventTypes.filter((e) => e.kind === kind).length > 1) {
      problems.push(`Only one event type can be the ${kind === 'period-start' ? 'period start' : 'period end'}.`);
    }
  }
  for (const a of def.attributes) {
    if (!a.label.trim()) problems.push('An attribute has no name.');
    if (hasOptions(a.type) && a.options.length === 0) problems.push(`"${a.label}" needs at least one choice.`);
    if (a.options.some((o) => !o.label.trim())) problems.push(`"${a.label}" has a choice without a name.`);
  }
  for (const d of def.diagrams) if (!d.label.trim()) problems.push('A diagram has no name.');
  return [...new Set(problems)];
}

export function ProfileEditorPage({ id, user }: { id: string; user: UserDto }) {
  const [saved, setSaved] = useState<ProfileDto | null>(null);
  const [name, setName] = useState('');
  const [sport, setSport] = useState('');
  const [def, setDef] = useState<ProfileDefinition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = (profile: ProfileDto) => {
    setSaved(profile);
    setName(profile.name);
    setSport(profile.sport);
    setDef(profile.definition);
  };

  useEffect(() => {
    api<{ profile: ProfileDto }>(`/profiles/${id}`)
      .then((res) => reset(res.profile))
      .catch((err) => setError(errorMessage(err)));
  }, [id]);

  const dirty =
    saved !== null &&
    def !== null &&
    (name !== saved.name || sport !== saved.sport || JSON.stringify(def) !== JSON.stringify(saved.definition));

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!saved || !def) return error ? <p className="error">{error}</p> : null;

  const readOnly = user.role !== 'analyst' || saved.archivedAt !== null;
  const problems = findProblems(def, name, sport);
  const update: Update = (fn) => setDef((current) => (current ? fn(current) : current));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await api<{ profile: ProfileDto }>(`/profiles/${id}`, {
        method: 'PUT',
        body: { name, sport, definition: def, baseVersion: saved.currentVersion },
      });
      const newVersion = res.profile.currentVersion !== saved.currentVersion;
      reset(res.profile);
      setNotice(newVersion ? `Saved as version ${res.profile.currentVersion}.` : 'Saved.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      const res = await api<{ profile: ProfileDto }>('/profiles', { body: { name: `${saved.name} (copy)`, copyFrom: id } });
      navigate(href.profile(res.profile.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const setArchived = async (archived: boolean) => {
    if (archived && !confirm(`Archive "${saved.name}"? New sessions can no longer use it; existing sessions keep it.`)) {
      return;
    }
    try {
      const res = await api<{ profile: ProfileDto }>(`/profiles/${id}/archive`, { body: { archived } });
      reset(res.profile);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const leave = (event: MouseEvent) => {
    if (dirty && !confirm('Discard unsaved changes?')) event.preventDefault();
  };

  return (
    <div className="stack-lg">
      <div className="row wrap">
        <a href={href.profiles()} onClick={leave}>
          ← Profiles
        </a>
      </div>

      <section className="card stack">
        <div className="row wrap">
          <input
            className="grow title-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={readOnly}
            aria-label="Profile name"
            maxLength={80}
          />
          <input value={sport} onChange={(e) => setSport(e.target.value)} disabled={readOnly} aria-label="Sport" maxLength={60} />
        </div>
        <div className="row wrap small muted">
          <span className="grow">
            Version {saved.currentVersion} · updated {formatDate(saved.updatedAt)} · used by {saved.sessionCount} session
            {saved.sessionCount === 1 ? '' : 's'}
            {saved.archivedAt && ' · archived'}
          </span>
          {user.role === 'analyst' && (
            <>
              <button onClick={copy}>Copy</button>
              <button onClick={() => setArchived(saved.archivedAt === null)}>
                {saved.archivedAt ? 'Restore' : 'Archive'}
              </button>
            </>
          )}
        </div>
        {readOnly && (
          <p className="muted small">
            {saved.archivedAt ? 'Archived profiles are read-only. Restore it to edit.' : 'Only analysts can edit profiles.'}
          </p>
        )}
      </section>

      <div className="editor-layout">
        <div className="stack-lg">
          <EventTypesSection def={def} update={update} readOnly={readOnly} />
          <AttributesSection def={def} update={update} readOnly={readOnly} />
          <DiagramsSection def={def} update={update} readOnly={readOnly} />
        </div>
        <aside>
          <PreviewPanel def={def} />
        </aside>
      </div>

      {!readOnly && (
        <div className="save-bar">
          {problems.length > 0 && (
            <ul className="error small problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {error && <p className="error small">{error}</p>}
          <div className="row wrap">
            <button className="primary" disabled={!dirty || saving || problems.length > 0} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button disabled={!dirty || saving} onClick={() => reset(saved)}>
              Discard changes
            </button>
            <span className="muted small">{dirty ? 'Unsaved changes' : notice}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ItemActions({
  index,
  count,
  onMove,
  onRemove,
  label,
}: {
  index: number;
  count: number;
  onMove: (delta: number) => void;
  onRemove: () => void;
  label: string;
}) {
  return (
    <span className="item-actions">
      <button className="icon" disabled={index === 0} onClick={() => onMove(-1)} aria-label={`Move ${label} up`}>
        ↑
      </button>
      <button className="icon" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={`Move ${label} down`}>
        ↓
      </button>
      <button className="icon" onClick={onRemove} aria-label={`Remove ${label}`}>
        ✕
      </button>
    </span>
  );
}

function AddRow({ placeholder, onAdd, children }: { placeholder: string; onAdd: (label: string) => void; children?: ReactNode }) {
  const [label, setLabel] = useState('');
  const add = () => {
    if (!label.trim()) return;
    onAdd(label.trim());
    setLabel('');
  };
  return (
    <div className="row wrap add-row">
      <input
        className="grow"
        placeholder={placeholder}
        value={label}
        maxLength={60}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
      />
      {children}
      <button onClick={add} disabled={!label.trim()}>
        Add
      </button>
    </div>
  );
}

function EventTypesSection({ def, update, readOnly }: { def: ProfileDefinition; update: Update; readOnly: boolean }) {
  const setAt = (index: number, patch: Partial<EventTypeDef>) =>
    update((d) => ({ ...d, eventTypes: replaceAt(d.eventTypes, index, { ...d.eventTypes[index], ...patch }) }));

  const add = (label: string) =>
    update((d) => {
      const used = new Set(d.eventTypes.map((e) => e.hotkey));
      const hotkey = [...label.toLowerCase()].find((ch) => HOTKEY_PATTERN.test(ch) && !used.has(ch)) ?? null;
      const key = keyFromLabel(label, d.eventTypes.map((e) => e.key));
      const color = PALETTE[d.eventTypes.length % PALETTE.length];
      return { ...d, eventTypes: [...d.eventTypes, { key, label, color, hotkey, kind: 'scene' }] };
    });

  const missingMarkers = missingStandardMarkers(def);
  const addStandardMarkers = () =>
    update((d) => ({ ...d, eventTypes: [...d.eventTypes, ...missingStandardMarkers(d)] }));

  const remove = (event: EventTypeDef) => {
    const only = [...def.attributes, ...def.diagrams].filter((x) => x.appliesTo.length === 1 && x.appliesTo[0] === event.key);
    const note = only.length
      ? `\n\n${only.map((x) => `"${x.label}"`).join(', ')} only apply to it and will then apply to all event types.`
      : '';
    if (!confirm(`Remove event type "${event.label}"?${note}`)) return;
    const strip = <T extends { appliesTo: string[] }>(x: T): T => ({ ...x, appliesTo: x.appliesTo.filter((k) => k !== event.key) });
    update((d) => ({
      eventTypes: d.eventTypes.filter((e) => e.key !== event.key),
      attributes: d.attributes.map(strip),
      diagrams: d.diagrams.map(strip),
    }));
  };

  return (
    <section className="card stack">
      <div>
        <h2>Event types</h2>
        <p className="muted small">
          The quick buttons taggers press while watching. A hotkey marks the moment from the keyboard. A scene covers a
          range for review; a moment or period start/end is a point in time (period markers split counts per period).
        </p>
      </div>
      {def.eventTypes.map((e, i) => (
        <div key={e.key} className="row wrap list-row">
          <input
            type="color"
            value={e.color}
            disabled={readOnly}
            onChange={(ev) => setAt(i, { color: ev.target.value })}
            aria-label={`${e.label} color`}
          />
          <input
            className="grow"
            value={e.label}
            disabled={readOnly}
            maxLength={60}
            onChange={(ev) => setAt(i, { label: ev.target.value })}
            aria-label="Event type name"
          />
          <select
            value={e.kind}
            disabled={readOnly}
            onChange={(ev) => setAt(i, { kind: ev.target.value as EventKind })}
            aria-label={`${e.label} kind`}
          >
            {EVENT_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          <label className="row small inline-label">
            Hotkey
            <input
              className="hotkey"
              value={e.hotkey ?? ''}
              placeholder="–"
              maxLength={1}
              disabled={readOnly}
              onChange={(ev) => setAt(i, { hotkey: ev.target.value.toLowerCase() || null })}
            />
          </label>
          <span className="key" title="Stable key used in exports">
            {e.key}
          </span>
          {!readOnly && (
            <ItemActions
              index={i}
              count={def.eventTypes.length}
              label={e.label}
              onMove={(delta) => update((d) => ({ ...d, eventTypes: move(d.eventTypes, i, delta) }))}
              onRemove={() => remove(e)}
            />
          )}
        </div>
      ))}
      {!readOnly && <AddRow placeholder="New event type, e.g. Turnover" onAdd={add} />}
      {!readOnly && missingMarkers.length > 0 && (
        <div className="row wrap small">
          <button onClick={addStandardMarkers}>Add standard markers</button>
          <span className="muted">{missingMarkers.map((m) => m.label).join(', ')}</span>
        </div>
      )}
    </section>
  );
}

function AppliesToPicker({
  eventTypes,
  value,
  onChange,
  readOnly,
}: {
  eventTypes: EventTypeDef[];
  value: string[];
  onChange: (value: string[]) => void;
  readOnly: boolean;
}) {
  const all = value.length === 0;
  return (
    <div className="applies small">
      <span className="muted">Asked for</span>
      <label className="inline-label">
        <input
          type="checkbox"
          checked={all}
          disabled={readOnly}
          onChange={() => onChange(all ? eventTypes.map((e) => e.key) : [])}
        />
        all event types
      </label>
      {!all &&
        eventTypes.map((e) => {
          const checked = value.includes(e.key);
          return (
            <label key={e.key} className="inline-label">
              <input
                type="checkbox"
                checked={checked}
                // At least one stays selected; "all event types" covers the rest.
                disabled={readOnly || (checked && value.length === 1)}
                onChange={() => onChange(checked ? value.filter((k) => k !== e.key) : [...value, e.key])}
              />
              {e.label}
            </label>
          );
        })}
    </div>
  );
}

function OptionsEditor({
  options,
  onChange,
  readOnly,
}: {
  options: OptionDef[];
  onChange: (options: OptionDef[]) => void;
  readOnly: boolean;
}) {
  return (
    <div className="stack-sm options">
      {options.map((o, i) => (
        <div key={o.key} className="row">
          <input
            className="grow"
            value={o.label}
            disabled={readOnly}
            maxLength={60}
            onChange={(e) => onChange(replaceAt(options, i, { ...o, label: e.target.value }))}
            aria-label="Choice"
          />
          {!readOnly && (
            <ItemActions
              index={i}
              count={options.length}
              label={o.label}
              onMove={(delta) => onChange(move(options, i, delta))}
              onRemove={() => onChange(options.filter((x) => x.key !== o.key))}
            />
          )}
        </div>
      ))}
      {!readOnly && (
        <AddRow
          placeholder="New choice"
          onAdd={(label) => onChange([...options, { key: keyFromLabel(label, options.map((o) => o.key)), label }])}
        />
      )}
    </div>
  );
}

function AttributesSection({ def, update, readOnly }: { def: ProfileDefinition; update: Update; readOnly: boolean }) {
  const [newType, setNewType] = useState<AttributeType>('single');
  const setAt = (index: number, patch: Partial<AttributeDef>) =>
    update((d) => ({ ...d, attributes: replaceAt(d.attributes, index, { ...d.attributes[index], ...patch }) }));

  const changeType = (index: number, type: AttributeType) => {
    const current = def.attributes[index];
    if (!hasOptions(type) && current.options.length > 0 && !confirm(`Remove the choices of "${current.label}"?`)) return;
    setAt(index, { type, options: hasOptions(type) ? current.options : [] });
  };

  return (
    <section className="card stack">
      <div>
        <h2>Attributes</h2>
        <p className="muted small">What analysts fill in for each scene. Limit an attribute to the event types it makes sense for.</p>
      </div>
      {def.attributes.map((a, i) => (
        <div key={a.key} className="item-card stack-sm">
          <div className="row wrap">
            <input
              className="grow"
              value={a.label}
              disabled={readOnly}
              maxLength={60}
              onChange={(e) => setAt(i, { label: e.target.value })}
              aria-label="Attribute name"
            />
            <select value={a.type} disabled={readOnly} onChange={(e) => changeType(i, e.target.value as AttributeType)}>
              {ATTRIBUTE_TYPES.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </select>
            <span className="key">{a.key}</span>
            {!readOnly && (
              <ItemActions
                index={i}
                count={def.attributes.length}
                label={a.label}
                onMove={(delta) => update((d) => ({ ...d, attributes: move(d.attributes, i, delta) }))}
                onRemove={() =>
                  confirm(`Remove attribute "${a.label}"?`) &&
                  update((d) => ({ ...d, attributes: d.attributes.filter((x) => x.key !== a.key) }))
                }
              />
            )}
          </div>
          {hasOptions(a.type) && (
            <OptionsEditor options={a.options} readOnly={readOnly} onChange={(options) => setAt(i, { options })} />
          )}
          <AppliesToPicker
            eventTypes={def.eventTypes}
            value={a.appliesTo}
            readOnly={readOnly}
            onChange={(appliesTo) => setAt(i, { appliesTo })}
          />
        </div>
      ))}
      {!readOnly && (
        <AddRow
          placeholder="New attribute, e.g. Shot type"
          onAdd={(label) =>
            update((d) => ({
              ...d,
              attributes: [
                ...d.attributes,
                { key: keyFromLabel(label, d.attributes.map((a) => a.key)), label, type: newType, options: [], appliesTo: [] },
              ],
            }))
          }
        >
          <select value={newType} onChange={(e) => setNewType(e.target.value as AttributeType)} aria-label="Type">
            {ATTRIBUTE_TYPES.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </AddRow>
      )}
    </section>
  );
}

function DiagramCard({
  diagram,
  def,
  onChange,
  actions,
  readOnly,
}: {
  diagram: DiagramDef;
  def: ProfileDefinition;
  onChange: (diagram: DiagramDef) => void;
  actions: ReactNode;
  readOnly: boolean;
}) {
  const [choosingImage, setChoosingImage] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const isImage = diagram.background.kind === 'image';
  const selected = choosingImage || isImage ? 'image' : `template:${diagram.background.kind === 'template' ? diagram.background.template : ''}`;

  const chooseBackground = (value: string) => {
    if (value === 'image') {
      setChoosingImage(true);
      return;
    }
    setChoosingImage(false);
    onChange({ ...diagram, background: { kind: 'template', template: value.slice('template:'.length) as DiagramTemplate } });
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const asset = await uploadImage(file);
      onChange({ ...diagram, background: { kind: 'image', assetId: asset.id, width: asset.width, height: asset.height } });
      setChoosingImage(false);
    } catch (err) {
      setUploadError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="item-card stack-sm">
      <div className="row wrap">
        <input
          className="grow"
          value={diagram.label}
          disabled={readOnly}
          maxLength={60}
          onChange={(e) => onChange({ ...diagram, label: e.target.value })}
          aria-label="Diagram name"
        />
        <select value={selected} disabled={readOnly} onChange={(e) => chooseBackground(e.target.value)} aria-label="Background">
          {DIAGRAM_TEMPLATES.map((t) => (
            <option key={t.template} value={`template:${t.template}`}>
              {t.label}
            </option>
          ))}
          <option value="image">Own image…</option>
        </select>
        <span className="key">{diagram.key}</span>
        {actions}
      </div>
      {!readOnly && (choosingImage || isImage) && (
        <div className="row wrap small">
          <label className="button">
            {uploading ? 'Uploading…' : isImage ? 'Replace image' : 'Choose image'}
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={uploading} onChange={upload} />
          </label>
          <span className="muted">PNG, JPEG or WebP, up to 5 MB.</span>
          {uploadError && <span className="error">{uploadError}</span>}
        </div>
      )}
      <DiagramPicker background={diagram.background} className="thumb" />
      <AppliesToPicker
        eventTypes={def.eventTypes}
        value={diagram.appliesTo}
        readOnly={readOnly}
        onChange={(appliesTo) => onChange({ ...diagram, appliesTo })}
      />
    </div>
  );
}

function DiagramsSection({ def, update, readOnly }: { def: ProfileDefinition; update: Update; readOnly: boolean }) {
  const [newTemplate, setNewTemplate] = useState<DiagramTemplate>(DIAGRAM_TEMPLATES[0].template);
  return (
    <section className="card stack">
      <div>
        <h2>Click diagrams</h2>
        <p className="muted small">Analysts click a position, e.g. where a shot came from or where it went in.</p>
      </div>
      {def.diagrams.map((d, i) => (
        <DiagramCard
          key={d.key}
          diagram={d}
          def={def}
          readOnly={readOnly}
          onChange={(diagram) => update((x) => ({ ...x, diagrams: replaceAt(x.diagrams, i, diagram) }))}
          actions={
            !readOnly && (
              <ItemActions
                index={i}
                count={def.diagrams.length}
                label={d.label}
                onMove={(delta) => update((x) => ({ ...x, diagrams: move(x.diagrams, i, delta) }))}
                onRemove={() =>
                  confirm(`Remove diagram "${d.label}"?`) &&
                  update((x) => ({ ...x, diagrams: x.diagrams.filter((y) => y.key !== d.key) }))
                }
              />
            )
          }
        />
      ))}
      {!readOnly && (
        <AddRow
          placeholder="New diagram, e.g. Shot location"
          onAdd={(label) =>
            update((d) => ({
              ...d,
              diagrams: [
                ...d.diagrams,
                {
                  key: keyFromLabel(label, d.diagrams.map((x) => x.key)),
                  label,
                  background: { kind: 'template', template: newTemplate },
                  appliesTo: [],
                },
              ],
            }))
          }
        >
          <select value={newTemplate} onChange={(e) => setNewTemplate(e.target.value as DiagramTemplate)} aria-label="Background">
            {DIAGRAM_TEMPLATES.map((t) => (
              <option key={t.template} value={t.template}>
                {t.label}
              </option>
            ))}
          </select>
        </AddRow>
      )}
    </section>
  );
}

function PreviewPanel({ def }: { def: ProfileDefinition }) {
  const [eventKey, setEventKey] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, AttributeValue>>({});
  const [points, setPoints] = useState<Record<string, DiagramPoint | null>>({});
  const current = def.eventTypes.find((e) => e.key === eventKey) ?? def.eventTypes[0] ?? null;
  const attributes = attributesFor(def, current?.key ?? null);
  const diagrams = diagramsFor(def, current?.key ?? null);

  return (
    <section className="card stack preview">
      <div>
        <h2>Preview</h2>
        <p className="muted small">Try it out. Nothing here is saved.</p>
      </div>
      <div className="field-label">Tagger buttons</div>
      <div className="event-buttons">
        {def.eventTypes.map((e) => (
          <button
            key={e.key}
            className={`event-button${e.key === current?.key ? ' selected' : ''}`}
            style={{ '--event-color': e.color } as CSSProperties}
            onClick={() => setEventKey(e.key)}
          >
            {isPointKind(e.kind) && <span title="Point in time">◆</span>}
            {e.label || '…'}
            {e.hotkey && <kbd>{e.hotkey.toUpperCase()}</kbd>}
          </button>
        ))}
      </div>
      {current && (
        <>
          <div className="field-label">Analysis form for “{current.label}”</div>
          {attributes.map((a) => (
            <AttributeField
              key={a.key}
              attribute={a}
              value={values[a.key] ?? null}
              onChange={(value) => setValues((v) => ({ ...v, [a.key]: value }))}
            />
          ))}
          {diagrams.map((d) => (
            <DiagramPicker
              key={d.key}
              background={d.background}
              label={d.label}
              value={points[d.key] ?? null}
              onChange={(point) => setPoints((p) => ({ ...p, [d.key]: point }))}
            />
          ))}
          {attributes.length === 0 && diagrams.length === 0 && (
            <p className="muted small">Nothing to fill in for this event type yet.</p>
          )}
        </>
      )}
    </section>
  );
}
