import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { askQuestion } from './api';
import type { Answer } from './api';

vi.mock('./api', () => ({ askQuestion: vi.fn() }));
const mockAsk = vi.mocked(askQuestion);
const answer: Answer = { answer: 'Ответ модели', model: 'nvidia/nemotron-3.5-lightning:free', truncated: false };

describe('App', () => {
  beforeEach(() => {
    mockAsk.mockReset();
  });

  it('shows OpenRouter attribution and data-sharing notice', () => {
    render(<App />);
    expect(screen.getByText('На базе OpenRouter')).toBeInTheDocument();
    expect(screen.getByText(/Вопрос отправляется через OpenRouter провайдеру модели/)).toBeInTheDocument();
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
    mockAsk.mockRejectedValueOnce(new Error('Лимит OpenRouter исчерпан.')).mockResolvedValueOnce(answer);
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText('Ваш вопрос'), 'Привет');
    await user.click(screen.getByRole('button', { name: /отправить/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Лимит OpenRouter исчерпан.');
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
    mockAsk.mockResolvedValue({ ...answer, answer: '<script>alert(1)</script>', truncated: true });
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.type(screen.getByLabelText('Ваш вопрос'), 'Привет');
    await user.click(screen.getByRole('button', { name: /отправить/i }));
    expect(await screen.findByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText(/Достигнут лимит длины ответа/)).toBeInTheDocument();
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
