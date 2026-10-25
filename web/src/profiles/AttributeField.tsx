// Input for one profile attribute, used in the profile preview and in the analyst's review form.
import type { AttributeValue as StoredValue } from '../../../shared/annotation.ts';
import type { AttributeDef } from '../../../shared/profile.ts';

/** null: no answer. */
export type AttributeValue = StoredValue | null;

interface Props {
  attribute: AttributeDef;
  value: AttributeValue;
  onChange: (value: AttributeValue) => void;
  disabled?: boolean;
}

export function AttributeField({ attribute, value, onChange, disabled = false }: Props) {
  const chip = (key: string, label: string, selected: boolean, onClick: () => void) => (
    <button
      key={key}
      type="button"
      className={`chip${selected ? ' selected' : ''}`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );

  let input;
  switch (attribute.type) {
    case 'single':
      input = attribute.options.map((o) => chip(o.key, o.label, value === o.key, () => onChange(value === o.key ? null : o.key)));
      break;
    case 'multi': {
      const selected = Array.isArray(value) ? value : [];
      input = attribute.options.map((o) =>
        chip(o.key, o.label, selected.includes(o.key), () =>
          onChange(selected.includes(o.key) ? selected.filter((k) => k !== o.key) : [...selected, o.key]),
        ),
      );
      break;
    }
    case 'boolean':
      input = [
        chip('yes', 'Yes', value === true, () => onChange(value === true ? null : true)),
        chip('no', 'No', value === false, () => onChange(value === false ? null : false)),
      ];
      break;
    case 'rating':
      input = [1, 2, 3, 4, 5].map((n) => chip(String(n), String(n), value === n, () => onChange(value === n ? null : n)));
      break;
    case 'number':
      input = (
        <input
          type="number"
          disabled={disabled}
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
      break;
    case 'text':
      input = (
        <textarea
          rows={2}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
      break;
  }

  return (
    <div className="field">
      <div className="field-label">{attribute.label}</div>
      <div className="chips">{input}</div>
    </div>
  );
}
