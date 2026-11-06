import { useId, useRef, useState } from 'react';
import type { MouseEvent, ReactElement } from 'react';
import { WORKSPACE_LABELS } from '../modes';
import type { Workspace } from '../modes';

interface WorkspaceMenuProps {
  selected: Workspace;
  onSelect: (workspace: Workspace) => void;
}

export function WorkspaceMenu({ selected, onSelect }: WorkspaceMenuProps): ReactElement {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  function open(): void {
    dialog.current?.showModal();
    setIsOpen(true);
  }

  function close(): void {
    dialog.current?.close();
  }

  function handleClose(): void {
    setIsOpen(false);
    trigger.current?.focus();
  }

  function handleBackdropClick(event: MouseEvent<HTMLDialogElement>): void {
    if (event.target !== event.currentTarget) return;
    const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
    const clickedOutside = event.clientX < left || event.clientX > right ||
      event.clientY < top || event.clientY > bottom;
    if (clickedOutside) close();
  }

  return (
    <>
      <button
        ref={trigger}
        className="menu-trigger"
        type="button"
        aria-label="Открыть меню"
        aria-expanded={isOpen}
        aria-controls={id}
        onClick={open}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <dialog
        ref={dialog}
        id={id}
        className="workspace-menu"
        aria-labelledby={`${id}-heading`}
        onCancel={(event) => { event.preventDefault(); close(); }}
        onClose={handleClose}
        onClick={handleBackdropClick}
      >
        <div className="menu-heading">
          <h2 id={`${id}-heading`}>Разделы</h2>
          <button className="menu-close" type="button" onClick={close} aria-label="Закрыть меню">×</button>
        </div>
        <nav aria-label="Разделы приложения">
          {(Object.keys(WORKSPACE_LABELS) as Workspace[]).map((workspace) => (
            <button
              key={workspace}
              type="button"
              aria-current={selected === workspace ? 'page' : undefined}
              autoFocus={selected === workspace}
              onClick={() => { onSelect(workspace); close(); }}
            >{WORKSPACE_LABELS[workspace]}</button>
          ))}
        </nav>
      </dialog>
    </>
  );
}
