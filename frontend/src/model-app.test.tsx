import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { askQuestion } from './api';
import type { Answer } from './api';
import { CHAT_MODELS, MODEL_LABELS } from './modes';
import { makeAnswer, makeModelAnswer, makeScopedAnswer } from './test-fixtures';
import { emptyProfiles, HISTORY_STORAGE_KEYS, saveConversations } from './conversations';
import { createConversationStore, HISTORY_REVISION, REVISION_KEY } from './conversation-store';

vi.mock('./api', async (original) => ({ ...await original<typeof import('./api')>(), askQuestion: vi.fn() }));
const mockAsk = vi.mocked(askQuestion);

function workspace(name: string): void {
  fireEvent.click(screen.getByRole('button', { name: 'Открыть меню' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name }));
}

function submit(question: string): void {
  const input = screen.getByLabelText('Ваш вопрос');
  fireEvent.change(input, { target: { value: question } });
  fireEvent.submit(input.closest('form')!);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(REVISION_KEY, HISTORY_REVISION);
  mockAsk.mockReset();
  mockAsk.mockImplementation(async (question, scope) => makeScopedAnswer(question, scope));
});

it('shows three accessible model tabs, keeps initial workspace and never generates on navigation', async () => {
  const user = userEvent.setup();
  render(<App />);
  expect(screen.getByRole('tab', { name: 'Минимум рассуждений' })).toHaveAttribute('aria-selected', 'true');
  workspace('Модели');
  expect(screen.getByRole('button', { name: 'Открыть меню' })).toHaveFocus();
  expect(within(screen.getByRole('tablist', { name: 'Модель' })).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(Object.values(MODEL_LABELS));
  expect(screen.getByRole('tab', { name: 'Kimi K2.7 Code' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByRole('tab', { name: 'Beam Free' })).not.toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: 'Gemini 4 Argon' })).not.toBeInTheDocument();
  expect(screen.queryByRole('tablist', { name: 'Температура генерации' })).not.toBeInTheDocument();
  expect(screen.queryByRole('tablist', { name: 'Режим рассуждений' })).not.toBeInTheDocument();
  expect(screen.queryByRole('tablist', { name: 'Способ решения' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: 'Kimi K2.7 Code' }));
  for (const [key, name] of [['ArrowRight', 'Grok 4.7'], ['End', 'GPT‑6 Luna'], ['Home', 'Kimi K2.7 Code']]) {
    await user.keyboard(`{${key}}`);
    expect(screen.getByRole('tab', { name })).toHaveFocus();
    expect(screen.getByRole('tabpanel', { name })).toBeInTheDocument();
  }
  expect(mockAsk).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: 'GPT‑6 Luna' }));
  workspace('Температура');
  workspace('Модели');
  expect(screen.getByRole('tab', { name: 'GPT‑6 Luna' })).toHaveAttribute('aria-selected', 'true');
});

it.each(CHAT_MODELS)('sends one direct question only to %s and restores its own history', async (model) => {
  const first = render(<App />);
  workspace('Модели');
  fireEvent.click(screen.getByRole('tab', { name: MODEL_LABELS[model] }));
  submit(`Вопрос ${model}`);
  await screen.findByText('Ответ модели');
  expect(mockAsk).toHaveBeenCalledExactlyOnceWith(`Вопрос ${model}`, {
    workspace: 'models', model, mode: 'direct',
  }, { direct: [] }, expect.any(AbortSignal), expect.any(String));
  expect(screen.getByRole('heading', { name: 'Ответ' })).toBeInTheDocument();
  expect(screen.getByText('Токенов потрачено: 142')).toBeInTheDocument();
  expect(screen.queryByText(/До настройки effort|Рассуждения отключены/)).not.toBeInTheDocument();
  first.unmount();
  render(<App />);
  workspace('Модели');
  fireEvent.click(screen.getByRole('tab', { name: MODEL_LABELS[model] }));
  await screen.findByText(`Вопрос ${model}`);
  submit('Уточнение');
  await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(2));
  expect(mockAsk.mock.calls[1][2]).toEqual({ direct: [
    { role: 'user', content: `Вопрос ${model}` }, { role: 'assistant', content: 'Ответ модели' },
  ] });
});

it('keeps separate drafts and pending scopes, allows another model, preserves errors and ignores cleared replies', async () => {
  const profiles = emptyProfiles();
  const old = makeAnswer('Старый диалог');
  profiles['reasoning:low:direct'] = [{ id: 'old', question: old.question, date: old.date, response: old, error: null }];
  saveConversations(profiles);
  const pending: { resolve: (answer: Answer) => void; reject: (error: Error) => void; answer: Answer }[] = [];
  mockAsk.mockImplementation((question, scope) => new Promise((resolve, reject) => {
    if (scope.workspace !== 'models') throw new Error();
    pending.push({ resolve, reject, answer: makeModelAnswer(question, scope.model) });
  }));
  const first = render(<App />);
  await screen.findByText('Старый диалог');
  workspace('Модели');
  submit('Kimi вопрос');
  await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText('Ваш вопрос')).toBeDisabled();
  fireEvent.submit(screen.getByLabelText('Ваш вопрос').closest('form')!);
  expect(mockAsk).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('tab', { name: 'Grok 4.7' }));
  submit('Grok вопрос');
  await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(2));
  await act(async () => pending[1].reject(new Error('Ошибка Grok')));
  expect(screen.getByRole('alert')).toHaveTextContent('Ошибка Grok');
  expect(screen.getByLabelText('Ваш вопрос')).toHaveValue('Grok вопрос');
  await act(async () => pending[0].resolve(pending[0].answer));
  expect(screen.getByLabelText('Ваш вопрос')).toHaveValue('Grok вопрос');
  fireEvent.click(screen.getByRole('tab', { name: 'Kimi K2.7 Code' }));
  expect(screen.getByLabelText('Ваш вопрос')).toHaveValue('');
  expect(screen.getByText('Ответ модели')).toBeInTheDocument();
  submit('Продолжение Kimi');
  await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(3));
  expect(mockAsk.mock.calls[2][2]).toEqual({ direct: [
    { role: 'user', content: 'Kimi вопрос' }, { role: 'assistant', content: 'Ответ модели' },
  ] });
  await act(async () => pending[2].resolve(pending[2].answer));
  first.unmount();
  render(<App />);
  await screen.findByText('Старый диалог');
  workspace('Модели');
  expect(screen.getByText('Продолжение Kimi')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Grok 4.7' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Ошибка Grok');
  expect(screen.getByLabelText('Ваш вопрос')).toHaveValue('');
  fireEvent.click(screen.getByRole('tab', { name: 'Kimi K2.7 Code' }));
  submit('Поздний');
  await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(4));
  workspace('Температура');
  fireEvent.click(screen.getByRole('button', { name: 'Очистить историю' }));
  await waitFor(() => expect(mockAsk.mock.calls[3][3].aborted).toBe(true));
  await act(async () => pending[3].resolve(pending[3].answer));
  workspace('Модели');
  expect(screen.queryByText('Поздний')).not.toBeInTheDocument();
  for (const key of HISTORY_STORAGE_KEYS) expect(localStorage.getItem(key)).toBeNull();
});

it.each(['Control', 'Meta'])('submits selected model with %s+Enter and safely renders HTML as text', async (modifier) => {
  const user = userEvent.setup();
  mockAsk.mockResolvedValue({ ...makeModelAnswer(), results: [{
    ...makeModelAnswer().results[0], answer: '<script>bad()</script>',
  }] });
  render(<App />);
  workspace('Модели');
  await waitFor(() => expect(screen.getByLabelText('Ваш вопрос')).toBeEnabled());
  await user.type(screen.getByLabelText('Ваш вопрос'), 'Привет');
  await user.keyboard(`{${modifier}>}{Enter}{/${modifier}}`);
  expect(await screen.findByText('<script>bad()</script>')).toBeInTheDocument();
  expect(document.querySelector('.answer-text script')).toBeNull();
  expect(mockAsk).toHaveBeenCalledTimes(1);
});

it('aborts a model request after ten minutes, retains its draft and permits retry', async () => {
  vi.useFakeTimers();
  try {
    mockAsk.mockImplementation((_question, _scope, _history, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    render(<App />);
    workspace('Модели');
    submit('Долго');
    await act(async () => vi.advanceTimersByTimeAsync(600_000));
    expect(screen.getByRole('alert')).toHaveTextContent('Время ожидания истекло');
    expect(screen.getByLabelText('Ваш вопрос')).toHaveValue('Долго');
    expect(screen.getByRole('button', { name: /отправить/i })).toBeEnabled();
    expect(mockAsk.mock.calls[0][3].aborted).toBe(true);
  } finally { vi.useRealTimers(); }
});

it('rejects another model response without removing previous history or clearing the draft', async () => {
  render(<App />);
  workspace('Модели');
  submit('Первый');
  await screen.findByText('Ответ модели');
  const actual = await vi.importActual<typeof import('./api')>('./api');
  mockAsk.mockImplementation(actual.askQuestion);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(makeModelAnswer('Второй', 'grok-4.7')))));
  try {
    submit('Второй');
    expect(await screen.findByRole('alert')).toHaveTextContent('некорректный ответ');
    expect(screen.getByText('Первый')).toBeInTheDocument();
    expect(screen.getAllByText('Ответ модели')).toHaveLength(1);
    expect(screen.getByLabelText('Ваш вопрос')).toHaveValue('Второй');
  } finally { vi.unstubAllGlobals(); }
});

it('clears drafts and aborts active model requests when another tab resets the revision', async () => {
  let resolve!: (answer: Answer) => void;
  mockAsk.mockImplementation(() => new Promise((done) => { resolve = done; }));
  render(<App />);
  workspace('Модели');
  submit('Старое поколение');
  await waitFor(() => expect(mockAsk).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('tab', { name: 'Grok 4.7' }));
  fireEvent.change(screen.getByLabelText('Ваш вопрос'), { target: { value: 'Черновик' } });
  localStorage.removeItem(REVISION_KEY);
  await act(async () => {
    await createConversationStore().refresh();
    window.dispatchEvent(new StorageEvent('storage', { key: REVISION_KEY }));
  });
  await waitFor(() => expect(mockAsk.mock.calls[0][3].aborted).toBe(true));
  expect(screen.getByLabelText('Ваш вопрос')).toHaveValue('');
  await act(async () => resolve(makeModelAnswer('Старое поколение')));
  fireEvent.click(screen.getByRole('tab', { name: 'Kimi K2.7 Code' }));
  expect(screen.queryByText('Старое поколение')).not.toBeInTheDocument();
  expect(screen.queryByText('Ответ модели')).not.toBeInTheDocument();
});

it('resets old history once, isolates all three models and preserves new answers until ordinary clear', async () => {
  localStorage.removeItem(REVISION_KEY);
  for (const key of HISTORY_STORAGE_KEYS) localStorage.setItem(key, 'Старая переписка');
  const first = render(<App />);
  expect(screen.getByLabelText('Ваш вопрос')).toBeDisabled();
  await waitFor(() => expect(screen.getByLabelText('Ваш вопрос')).toBeEnabled());
  expect(screen.queryByText('Старая переписка')).not.toBeInTheDocument();
  workspace('Модели');
  for (const model of CHAT_MODELS) {
    fireEvent.click(screen.getByRole('tab', { name: MODEL_LABELS[model] }));
    submit(model);
    await screen.findByText('Ответ модели');
    expect(mockAsk.mock.lastCall?.[2]).toEqual({ direct: [] });
  }
  first.unmount();
  const second = render(<App />);
  await waitFor(() => expect(screen.getByLabelText('Ваш вопрос')).toBeEnabled());
  workspace('Модели');
  for (const model of CHAT_MODELS) {
    fireEvent.click(screen.getByRole('tab', { name: MODEL_LABELS[model] }));
    expect(screen.getByText(model)).toBeInTheDocument();
    expect(screen.getAllByText('Ответ модели')).toHaveLength(1);
  }
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Очистить историю' })));
  expect(localStorage.getItem(REVISION_KEY)).toBe(HISTORY_REVISION);
  second.unmount();
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText('Ваш вопрос')).toBeEnabled());
  workspace('Модели');
  expect(screen.queryByText('Ответ модели')).not.toBeInTheDocument();
  expect(mockAsk).toHaveBeenCalledTimes(3);
});
