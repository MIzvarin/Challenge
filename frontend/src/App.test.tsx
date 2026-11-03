import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { askQuestion } from './api';
import type { Answer } from './api';

vi.mock('./api', () => ({ askQuestion: vi.fn() }));
const mockAsk = vi.mocked(askQuestion);
const answer: Answer = {
  question: 'Привет',
  date: '2026-11-03T12:30:00Z',
  tokens: 142,
  answer: 'Ответ модели',
};

describe('App', () => {
  beforeEach(() => {
    mockAsk.mockReset();
  });

  it('shows DeepSeek and OpenCode Go attribution and data-sharing notice', () => {
    render(<App />);
    expect(screen.getByText('DeepSeek · OpenCode Go')).toBeInTheDocument();
    expect(screen.getByText(/Вопрос отправляется через OpenCode Go провайдеру DeepSeek/)).toBeInTheDocument();
  });

  it('rejects empty and whitespace-only questions', async () => {
    const user = userEvent.setup();
    render(<App />);
    const submit = screen.getByRole('button', { name: /отправить/i });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Ваш вопрос'), '   ');
    expect(submit).toBeDisabled();
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('sends a trimmed question and shows the answer', async () => {
    mockAsk.mockResolvedValue(answer);
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText('Ваш вопрос'), '  Привет  ');
    await user.click(screen.getByRole('button', { name: /отправить/i }));
    expect(await screen.findByText('Ответ модели')).toBeInTheDocument();
    expect(mockAsk).toHaveBeenCalledWith('Привет', expect.any(AbortSignal));
    expect(screen.getByText('Привет', { selector: 'p' })).toHaveClass('answer-question');
    expect(screen.getByText('Токенов потрачено: 142')).toBeInTheDocument();
    const timestamp = document.querySelector('time');
    expect(timestamp).toHaveAttribute('datetime', answer.date);
    expect(timestamp).toHaveTextContent(/03\.11\.(?:20)?26/);

    await user.clear(screen.getByLabelText('Ваш вопрос'));
    await user.type(screen.getByLabelText('Ваш вопрос'), 'Другой вопрос');
    expect(screen.getByText('Привет')).toBeInTheDocument();
  });

  it('blocks duplicate requests while waiting', async () => {
    let resolve!: (value: Answer) => void;
    mockAsk.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText('Ваш вопрос'), 'Привет');
    await user.click(screen.getByRole('button', { name: /отправить/i }));
    expect(screen.getByText('Получаем ответ…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /отправляем/i })).toBeDisabled();
    expect(screen.getByLabelText('Ваш вопрос')).toBeDisabled();
    expect(mockAsk).toHaveBeenCalledTimes(1);
    await act(async () => resolve(answer));
  });

  it('shows errors and permits another attempt', async () => {
    mockAsk.mockRejectedValueOnce(new Error('Лимит OpenCode Go исчерпан.')).mockResolvedValueOnce(answer);
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText('Ваш вопрос'), 'Привет');
    await user.click(screen.getByRole('button', { name: /отправить/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Лимит OpenCode Go исчерпан.');
    await user.click(screen.getByRole('button', { name: /отправить/i }));
    expect(await screen.findByText('Ответ модели')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('supports Ctrl+Enter', async () => {
    mockAsk.mockResolvedValue(answer);
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText('Ваш вопрос'), 'Привет');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByText('Ответ модели')).toBeInTheDocument();
  });

  it('renders provider HTML as text, not executable markup', async () => {
    mockAsk.mockResolvedValue({
      ...answer,
      question: '<img src=x onerror=alert(1)>',
      answer: '<script>alert(1)</script>',
    });
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.type(screen.getByLabelText('Ваш вопрос'), 'Привет');
    await user.click(screen.getByRole('button', { name: /отправить/i }));
    expect(await screen.findByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('aborts the active request on unmount', async () => {
    mockAsk.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    await user.type(screen.getByLabelText('Ваш вопрос'), 'Привет');
    await user.click(screen.getByRole('button', { name: /отправить/i }));
    const signal = mockAsk.mock.calls[0][1];
    unmount();
    await waitFor(() => expect(signal.aborted).toBe(true));
  });

  it('aborts a slow request and allows retrying after the timeout', async () => {
    vi.useFakeTimers();
    try {
      mockAsk.mockImplementation((_question, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
      render(<App />);
      const input = screen.getByLabelText('Ваш вопрос');
      fireEvent.change(input, { target: { value: 'Привет' } });
      fireEvent.submit(input.closest('form')!);
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(screen.getByRole('alert')).toHaveTextContent('Время ожидания истекло');
      expect(screen.getByRole('button', { name: /отправить/i })).toBeEnabled();
      expect(mockAsk.mock.calls[0][1].aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
