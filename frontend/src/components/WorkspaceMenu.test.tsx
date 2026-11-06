import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceMenu } from './WorkspaceMenu';

describe('WorkspaceMenu', () => {
  it('opens a labelled dialog with both sections and the current selection', () => {
    const onSelect = vi.fn();
    render(<WorkspaceMenu selected="reasoning" onSelect={onSelect} />);
    const trigger = screen.getByRole('button', { name: 'Открыть меню' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Разделы' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', dialog.id);
    expect(within(dialog).getByRole('button', { name: 'Подходы к решению' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Температура' }));
    expect(onSelect).toHaveBeenCalledWith('temperature');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it.each(['button', 'escape', 'backdrop'] as const)('closes with %s and restores focus', (method) => {
    render(<WorkspaceMenu selected="temperature" onSelect={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Открыть меню' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog');
    if (method === 'button') fireEvent.click(screen.getByRole('button', { name: 'Закрыть меню' }));
    else if (method === 'escape') fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
    else fireEvent.click(dialog, { clientX: -1 });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
