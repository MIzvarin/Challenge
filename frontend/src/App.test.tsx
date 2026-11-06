import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { askQuestion } from './api';
import type { Answer } from './api';
import { LEGACY_STORAGE_KEY, STORAGE_KEY } from './conversations';
import { GENERATION_KEY } from './conversation-store';
import { MODE_LABELS, MODES } from './modes';
import { makeAnswer } from './test-fixtures';

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(), askQuestion: vi.fn(),
}));
const mockAsk = vi.mocked(askQuestion);

function submit(question = 'Привет', container?: HTMLElement) {
  // Simulated browser tabs share this test document, so their form IDs overlap.
  const input = container ? within(container).getByRole('textbox') : screen.getByLabelText('Ваш вопрос');
  fireEvent.change(input, { target: { value: question } });
  fireEvent.submit(input.closest('form')!);
}

describe('App', () => {
  beforeEach(() => {
    localStorage.clear();
    mockAsk.mockReset();
    mockAsk.mockImplementation(async (question, mode, _history, _signal, effort) => makeAnswer(question, mode, effort));
  });

  it('shows two reasoning tabs above five method tabs and a neutral data-sharing notice', () => {
    render(<App />);
    expect(within(screen.getByRole('tablist', { name: 'Способ решения' })).getAllByRole('tab')).toHaveLength(5);
    expect(within(screen.getByRole('tablist', { name: 'Режим рассуждений' })).getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tab', { name: 'Минимум рассуждений' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Прямой ответ' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText(/DeepSeek|OpenCode/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Вопрос и история отправляются внешнему ИИ-сервису/)).toBeInTheDocument();
  });

  it('rejects empty and whitespace-only questions', () => {
    render(<App />);
    const button = screen.getByRole('button', { name: /отправить/i });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Ваш вопрос'), { target: { value: '   ' } });
    expect(button).toBeDisabled();
    fireEvent.submit(screen.getByLabelText('Ваш вопрос').closest('form')!);
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('sends and restores questions longer than the former character limit', async () => {
    const question = 'Длинная задача. '.repeat(1500);
    const first = render(<App />);
    expect(screen.getByLabelText('Ваш вопрос')).not.toHaveAttribute('maxlength');
    submit(question);
    await screen.findByText('Ответ модели');
    expect(mockAsk.mock.calls[0][0]).toBe(question.trim());
    first.unmount();
    render(<App />);
    expect(screen.getByText(question.trim())).toBeInTheDocument();
    submit('Уточнение');
    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(2));
    expect(mockAsk.mock.calls[1][2].direct![0].content).toBe(question.trim());
    await waitFor(() => expect(screen.getAllByText('Ответ модели')).toHaveLength(2));
  });

  it('keeps earlier messages and passes them with the next question', async () => {
    render(<App />);
    submit('  Привет  ');
    expect(await screen.findByText('Ответ модели')).toBeInTheDocument();
    expect(mockAsk).toHaveBeenNthCalledWith(1, 'Привет', 'direct', { direct: [] }, expect.any(AbortSignal), 'low', expect.any(String));
    expect(screen.getByText('Привет', { selector: 'p' })).toHaveClass('answer-question');
    expect(screen.getByText('Токенов потрачено: 142')).toBeInTheDocument();
    expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-11-03T12:30:00Z');
    expect(screen.getByLabelText('Ваш вопрос')).toHaveValue('');

    submit('Уточни');
    await waitFor(() => expect(screen.getAllByText('Ответ модели')).toHaveLength(2));
    expect(mockAsk).toHaveBeenNthCalledWith(2, 'Уточни', 'direct', { direct: [
      { role: 'user', content: 'Привет' }, { role: 'assistant', content: 'Ответ модели' },
    ] }, expect.any(AbortSignal), 'low', mockAsk.mock.calls[0][5]);
    expect(screen.getByText('Привет')).toBeInTheDocument();
  });

  it.each(MODES)('sends the selected %s mode', async (mode) => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: MODE_LABELS[mode] }));
    submit();
    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('Получаем ответ…')).not.toBeInTheDocument());
    expect(mockAsk.mock.calls[0][1]).toBe(mode);
    expect(screen.getByRole('tabpanel', { name: MODE_LABELS[mode] })).toHaveAttribute('aria-labelledby', `tab-${mode}`);
    expect(screen.getAllByText('Ответ модели')).toHaveLength(mode === 'compare' ? 4 : 1);
  });

  it('isolates histories and drafts between tabs', async () => {
    render(<App />);
    submit('Прямой вопрос');
    await screen.findByText('Ответ модели');
    fireEvent.change(screen.getByLabelText('Ваш вопрос'), { target: { value: 'Черновик' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Пошаговое решение' }));
    expect(screen.queryByText('Прямой вопрос')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Ваш вопрос')).toHaveValue('');
    submit('Другой вопрос');
    await screen.findByText('Ответ модели');
    expect(mockAsk).toHaveBeenNthCalledWith(2, 'Другой вопрос', 'steps', { steps: [] }, expect.any(AbortSignal), 'low', expect.any(String));
    fireEvent.click(screen.getByRole('tab', { name: 'Прямой ответ' }));
    expect(screen.getByText('Прямой вопрос')).toBeInTheDocument();
    expect(screen.queryByText('Другой вопрос')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Ваш вопрос')).toHaveValue('Черновик');
  });

  it('restores each tab from local storage after remounting', async () => {
    const first = render(<App />);
    submit('Первый вопрос');
    await screen.findByText('Ответ модели');
    fireEvent.click(screen.getByRole('tab', { name: 'Команда ролей' }));
    submit('Ролевой вопрос');
    await screen.findByText('Ответ модели');
    first.unmount();
    render(<App />);
    expect(screen.getByText('Первый вопрос')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Команда ролей' }));
    expect(screen.getByText('Ролевой вопрос')).toBeInTheDocument();
    submit('Проверь ещё раз');
    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(3));
    const history = mockAsk.mock.calls[2][2].roles!;
    expect(history[0].content).toBe('Ролевой вопрос');
    expect(history[1].content).toContain('Разбор задачи');
    expect(history[1].content).toContain('Ответ модели');
    expect(mockAsk.mock.calls[2][5]).toBe(mockAsk.mock.calls[1][5]);
    await waitFor(() => expect(screen.queryByText('Получаем ответ…')).not.toBeInTheDocument());
  });

  it('isolates conversations, drafts, and context between effort profiles and restores both', async () => {
    const first = render(<App />);
    submit('Вопрос минимуму');
    await screen.findByText('Ответ модели');
    fireEvent.change(screen.getByLabelText('Ваш вопрос'), { target: { value: 'Черновик минимума' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Максимум рассуждений' }));
    expect(screen.queryByText('Вопрос минимуму')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Ваш вопрос')).toHaveValue('');
    submit('Вопрос максимуму');
    await screen.findByText('Ответ модели');
    expect(mockAsk).toHaveBeenNthCalledWith(2, 'Вопрос максимуму', 'direct', { direct: [] }, expect.any(AbortSignal), 'max', expect.any(String));
    expect(screen.getByText('effort: max')).toBeInTheDocument();
    submit('Уточнение максимуму');
    await waitFor(() => expect(screen.getAllByText('Ответ модели')).toHaveLength(2));
    expect(mockAsk.mock.calls[2][2].direct).toEqual([
      { role: 'user', content: 'Вопрос максимуму' }, { role: 'assistant', content: 'Ответ модели' },
    ]);
    fireEvent.click(screen.getByRole('tab', { name: 'Минимум рассуждений' }));
    expect(screen.getByLabelText('Ваш вопрос')).toHaveValue('Черновик минимума');
    expect(screen.getByText('Вопрос минимуму')).toBeInTheDocument();
    first.unmount();
    render(<App />);
    expect(screen.getByText('Вопрос минимуму')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Максимум рассуждений' }));
    expect(screen.getByText('Вопрос максимуму')).toBeInTheDocument();
    expect(screen.getByText('Уточнение максимуму')).toBeInTheDocument();
  });

  it('keeps simultaneous requests in different effort profiles independent and clears both', async () => {
    const pending: { resolve: (answer: Answer) => void; answer: Answer }[] = [];
    mockAsk.mockImplementation((question, mode, _history, _signal, effort) => new Promise((resolve) => {
      pending.push({ resolve, answer: makeAnswer(question, mode, effort) });
    }));
    render(<App />);
    submit('Минимум');
    fireEvent.click(screen.getByRole('tab', { name: 'Максимум рассуждений' }));
    expect(screen.getByLabelText('Ваш вопрос')).toBeEnabled();
    submit('Максимум');
    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(2));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Очистить историю' })));
    expect(mockAsk.mock.calls.every((call) => call[3].aborted)).toBe(true);
    await act(async () => pending.forEach(({ resolve, answer }) => resolve(answer)));
    expect(screen.queryByText('Ответ модели')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Минимум рассуждений' }));
    expect(screen.queryByText('Ответ модели')).not.toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it('keeps failed comparison cards alongside successful answers', async () => {
    const answer = makeAnswer('Привет', 'compare');
    answer.results[1] = { ...answer.results[1], answer: null, tokens: null, error: 'Ошибка подхода' };
    answer.tokens = null;
    mockAsk.mockResolvedValue(answer);
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Сравнение' }));
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Ошибка подхода');
    expect(screen.getAllByText('Ответ модели')).toHaveLength(3);
    expect(screen.getByText('Полный расход токенов неизвестен')).toBeInTheDocument();
  });

  it('blocks duplicate requests while waiting but allows switching tabs', async () => {
    let resolve!: (value: Answer) => void;
    mockAsk.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(<App />);
    submit();
    expect(await screen.findByText('Получаем ответ…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /отправляем/i })).toBeDisabled();
    expect(screen.getByLabelText('Ваш вопрос')).toBeDisabled();
    fireEvent.submit(screen.getByLabelText('Ваш вопрос').closest('form')!);
    expect(mockAsk).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('tab', { name: 'Пошаговое решение' }));
    submit('Вторая вкладка');
    await screen.findByText('Ответ модели');
    await act(async () => resolve(makeAnswer()));
    expect(screen.queryByText('Привет')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Прямой ответ' }));
    expect(screen.getByText('Привет')).toBeInTheDocument();
  });

  it('persists errors without removing previous answers and allows retrying', async () => {
    render(<App />);
    submit();
    await screen.findByText('Ответ модели');
    mockAsk.mockRejectedValueOnce(new Error('Лимит исчерпан.'));
    submit('Следующий вопрос');
    expect(await screen.findByRole('alert')).toHaveTextContent('Лимит исчерпан.');
    expect(screen.getByText('Ответ модели')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /отправить/i })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /отправить/i }));
    await waitFor(() => expect(screen.getAllByText('Ответ модели')).toHaveLength(2));
    expect(mockAsk.mock.calls[2][2].direct).toHaveLength(2);
  });

  it('supports Ctrl+Enter and keyboard tab navigation', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('tab', { name: 'Прямой ответ' }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Пошаговое решение' })).toHaveFocus();
    await user.type(screen.getByLabelText('Ваш вопрос'), 'Привет');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByText('Ответ модели')).toBeInTheDocument();
    expect(mockAsk.mock.calls[0][1]).toBe('steps');
  });

  it('renders provider HTML as text, including intermediate stages', async () => {
    const answer = makeAnswer('<img src=x onerror=alert(1)>', 'prompt');
    answer.results[0].answer = '<script>alert(1)</script>';
    answer.results[0].stages[0].content = '<iframe src=x></iframe>';
    mockAsk.mockResolvedValue(answer);
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Промпт → решение' }));
    submit(answer.question);
    expect(await screen.findByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(screen.getByText('<img src=x onerror=alert(1)>', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('<iframe src=x></iframe>')).toBeInTheDocument();
    expect(container.querySelector('script, img, iframe')).toBeNull();
  });

  it('clears every tab, aborts pending requests, and ignores late replies', async () => {
    const { unmount } = render(<App />);
    submit('Сохранённый вопрос');
    await screen.findByText('Ответ модели');
    let resolve!: (value: Answer) => void;
    mockAsk.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.click(screen.getByRole('tab', { name: 'Команда ролей' }));
    submit('Долгий вопрос');
    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(2));
    const signal = mockAsk.mock.calls[1][3];
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Очистить историю' })));
    expect(signal.aborted).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    await act(async () => resolve(makeAnswer('Долгий вопрос', 'roles')));
    for (const mode of MODES) {
      fireEvent.click(screen.getByRole('tab', { name: MODE_LABELS[mode] }));
      expect(screen.queryByText('Ответ модели')).not.toBeInTheDocument();
      expect(screen.getByText(/Задайте первую задачу/)).toBeInTheDocument();
    }
    unmount();
    render(<App />);
    expect(screen.getByText(/Задайте первую задачу/)).toBeInTheDocument();
  });

  it('aborts all active requests on unmount', async () => {
    mockAsk.mockImplementation(() => new Promise(() => {}));
    const { unmount } = render(<App />);
    submit();
    fireEvent.click(screen.getByRole('tab', { name: 'Пошаговое решение' }));
    submit('Другой');
    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(2));
    unmount();
    expect(mockAsk.mock.calls.every((call) => call[3].aborted)).toBe(true);
  });

  it('does not let a cleared request overwrite a new conversation or its draft', async () => {
    const pending: ((answer: Answer) => void)[] = [];
    mockAsk.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    render(<App />);
    submit('Старый вопрос');
    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(1));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Очистить историю' })));
    submit('Новый вопрос');
    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(2));
    expect(mockAsk.mock.calls[1][5]).not.toBe(mockAsk.mock.calls[0][5]);

    await act(async () => pending[0](makeAnswer('Старый вопрос')));
    expect(screen.queryByText('Старый вопрос')).not.toBeInTheDocument();
    expect(screen.getByText('Получаем ответ…')).toBeInTheDocument();
    expect(screen.getByLabelText('Ваш вопрос')).toHaveValue('Новый вопрос');

    await act(async () => pending[1](makeAnswer('Новый вопрос')));
    expect(screen.getAllByText('Ответ модели')).toHaveLength(1);
    expect(screen.getByText('Новый вопрос')).toBeInTheDocument();
    expect(screen.getByLabelText('Ваш вопрос')).toHaveValue('');
  });

  it('merges browser-tab updates and sends fresh context even before storage events arrive', async () => {
    const first = render(<App />);
    const second = render(<App />);
    submit('Первый вопрос', first.container);
    await within(first.container).findByText('Ответ модели');
    submit('Уточнение из другой вкладки', second.container);
    await within(second.container).findByText('Уточнение из другой вкладки');
    await waitFor(() => expect(within(second.container).getAllByText('Ответ модели')).toHaveLength(2));
    expect(mockAsk.mock.calls[1][2].direct).toEqual([
      { role: 'user', content: 'Первый вопрос' }, { role: 'assistant', content: 'Ответ модели' },
    ]);
    expect(mockAsk.mock.calls[1][5]).toBe(mockAsk.mock.calls[0][5]);
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY })));
    expect(within(first.container).getAllByText('Ответ модели')).toHaveLength(2);
  });

  it('clears another browser tab, aborts its request, and keeps late replies out of a new conversation', async () => {
    const first = render(<App />);
    const second = render(<App />);
    submit('Сохранённая задача', first.container);
    await within(first.container).findByText('Ответ модели');
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY })));
    expect(within(second.container).getByText('Сохранённая задача')).toBeInTheDocument();
    let resolve!: (answer: Answer) => void;
    mockAsk.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    submit('Долгий вопрос', second.container);
    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(2));
    const oldGeneration = mockAsk.mock.calls[1][5];
    await act(async () => fireEvent.click(within(first.container).getByRole('button', { name: 'Очистить историю' })));
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: GENERATION_KEY })));
    expect(mockAsk.mock.calls[1][3].aborted).toBe(true);
    expect(within(second.container).queryByText('Сохранённая задача')).not.toBeInTheDocument();
    expect(within(second.container).getByRole('textbox')).toHaveValue('');

    submit('Новая задача', second.container);
    await within(second.container).findByText('Ответ модели');
    expect(mockAsk.mock.calls[2][2]).toEqual({ direct: [] });
    expect(mockAsk.mock.calls[2][5]).not.toBe(oldGeneration);
    await act(async () => resolve(makeAnswer('Долгий вопрос')));
    expect(within(second.container).getAllByText('Ответ модели')).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).low.direct.map((turn: { question: string }) => turn.question)).toEqual(['Новая задача']);
  });

  it('rejects a late browser-tab reply when a clear notification has not arrived yet', async () => {
    const first = render(<App />);
    const second = render(<App />);
    let resolve!: (answer: Answer) => void;
    mockAsk.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    submit('Удалённая задача', second.container);
    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(1));
    await act(async () => fireEvent.click(within(first.container).getByRole('button', { name: 'Очистить историю' })));
    await act(async () => resolve(makeAnswer('Удалённая задача')));
    expect(within(second.container).queryByText('Ответ модели')).not.toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(mockAsk.mock.calls[0][3].aborted).toBe(true);
  });

  it('does not mistake another browser tab’s live request for an interrupted one', async () => {
    const first = render(<App />);
    const second = render(<App />);
    fireEvent.change(within(second.container).getByRole('textbox'), { target: { value: 'Дубликат' } });
    let resolve!: (answer: Answer) => void;
    mockAsk.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    submit('Один запрос', first.container);
    await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(1));
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY })));
    expect(within(second.container).getByText('Получаем ответ…')).toBeInTheDocument();
    expect(within(second.container).queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => fireEvent.submit(within(second.container).getByRole('textbox').closest('form')!));
    expect(mockAsk).toHaveBeenCalledTimes(1);
    await act(async () => resolve(makeAnswer('Один запрос')));
    expect(mockAsk).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY })));
    expect(within(second.container).getByText('Ответ модели')).toBeInTheDocument();
    expect(within(second.container).getByRole('textbox')).toBeEnabled();
  });

  it('reserves a conversation atomically when two browser tabs submit at once', async () => {
    const first = render(<App />);
    const second = render(<App />);
    let resolve!: (answer: Answer) => void;
    mockAsk.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await act(async () => {
      submit('Первый', first.container);
      submit('Второй', second.container);
    });
    expect(mockAsk).toHaveBeenCalledTimes(1);
    await act(async () => resolve(makeAnswer('Первый')));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).low.direct).toHaveLength(1);
    expect(within(second.container).getByRole('textbox')).toHaveValue('Второй');
  });

  it('does not dispatch or persist a queued submission after unmount', async () => {
    const { unmount } = render(<App />);
    submit();
    unmount();
    await act(async () => {});
    expect(mockAsk).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('aborts a slow request after ten minutes and permits retrying', async () => {
    vi.useFakeTimers();
    try {
      mockAsk.mockImplementation((_question, _mode, _history, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
      render(<App />);
      submit();
      await act(async () => vi.advanceTimersByTimeAsync(600_000));
      expect(screen.getByRole('alert')).toHaveTextContent('Время ожидания истекло');
      expect(screen.getByRole('button', { name: /отправить/i })).toBeEnabled();
      expect(mockAsk.mock.calls[0][3].aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns about unavailable storage without losing the current conversation', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota'); });
    try {
      render(<App />);
      submit();
      await screen.findByText('Ответ модели');
      expect(screen.getByRole('alert')).toHaveTextContent('Не удалось сохранить историю');
      expect(screen.getByText('Привет')).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it('recovers from corrupt saved data without overwriting it until the user acts', async () => {
    localStorage.setItem(STORAGE_KEY, '{broken');
    render(<App />);
    expect(screen.getByRole('alert')).toHaveTextContent('Не удалось прочитать историю');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('{broken');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Очистить историю' })));
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
