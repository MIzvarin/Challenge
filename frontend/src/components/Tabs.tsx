import type { ReactElement } from 'react';
import { EFFORTS, EFFORT_LABELS, MODES, MODE_LABELS } from '../modes';
import type { Effort, Mode } from '../modes';

interface TabsProps<T extends string> {
  selected: T;
  onSelect: (value: T) => void;
  values: readonly T[];
  labels: Record<T, string>;
  label: string;
  prefix: string;
  numbered?: boolean;
}

function Tabs<T extends string>({ selected, onSelect, values, labels, label, prefix, numbered = false }: TabsProps<T>): ReactElement {
  return (
    <div className={numbered ? 'mode-tabs' : 'effort-tabs'} role="tablist" aria-label={label}>
      {values.map((value, index) => (
        <button
          key={value}
          type="button"
          role="tab"
          id={`tab-${prefix}${value}`}
          aria-selected={selected === value}
          aria-controls={`panel-${prefix}${value}`}
          tabIndex={selected === value ? 0 : -1}
          onClick={() => onSelect(value)}
          onKeyDown={(event) => {
            let next = index;
            if (event.key === 'ArrowRight') next = (index + 1) % values.length;
            else if (event.key === 'ArrowLeft') next = (index + values.length - 1) % values.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = values.length - 1;
            else return;
            event.preventDefault();
            onSelect(values[next]);
            document.getElementById(`tab-${prefix}${values[next]}`)?.focus();
          }}
        >
          {numbered && <span className="tab-number" aria-hidden="true">0{index + 1}</span>}
          {labels[value]}
        </button>
      ))}
    </div>
  );
}

export function ModeTabs(props: Pick<TabsProps<Mode>, 'selected' | 'onSelect'>): ReactElement {
  return <Tabs {...props} values={MODES} labels={MODE_LABELS} label="Способ решения" prefix="" numbered />;
}

export function EffortTabs(props: Pick<TabsProps<Effort>, 'selected' | 'onSelect'>): ReactElement {
  return <Tabs {...props} values={EFFORTS} labels={EFFORT_LABELS} label="Режим рассуждений" prefix="effort-" />;
}
