import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Answer } from '../api';
import type { Turn } from '../conversations';
import { makeAnswer, makeTemperatureAnswer } from '../test-fixtures';
import { AnswerPanel } from './AnswerPanel';

function turn(response: Answer): Turn {
  return { id: 'turn', question: response.question, date: response.date, response, error: null };
}

describe('AnswerPanel', () => {
  it.each([0, 0.7, 1.2] as const)('preserves answer layout with temperature %s metadata', (temperature) => {
    const response = makeTemperatureAnswer('Вопрос', temperature);
    const { container } = render(<AnswerPanel turns={[turn(response)]} />);
    expect(screen.getByText(`temperature: ${temperature} · Рассуждения отключены`)).toBeInTheDocument();
    expect(screen.queryByText(/effort/i)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ответ' })).toBeInTheDocument();
    expect(screen.getByText('Вопрос', { selector: '.answer-question' })).toBeInTheDocument();
    expect(container.querySelector('time')).toHaveAttribute('datetime', response.date);
    expect(screen.getByText('1,3 сек.')).toBeInTheDocument();
    expect(screen.getByText('Токенов потрачено: 142')).toBeInTheDocument();
    expect(screen.getByText('Ответ модели')).toBeInTheDocument();
    expect(container.querySelector('details')).toBeNull();
  });

  it('does not assign effort retroactively and keeps the critic and stage cards', () => {
    const response = makeAnswer('Роли', 'roles');
    delete response.effort;
    render(<AnswerPanel turns={[turn(response)]} />);
    expect(screen.getByText('До настройки effort')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Итог критика' })).toBeInTheDocument();
    expect(screen.getByText('Аналитик', { exact: false, selector: 'summary' })).toBeInTheDocument();
    expect(screen.getByText('Исполнитель', { exact: false, selector: 'summary' })).toBeInTheDocument();
  });

  it('renders temperature HTML as text alongside pending and failed turns', () => {
    const response = makeTemperatureAnswer('<img src=x>', 0);
    response.results[0].answer = '<script>alert(1)</script>';
    const base = turn(response);
    const { container } = render(<AnswerPanel turns={[
      base,
      { ...base, id: 'pending', response: null },
      { ...base, id: 'failed', response: null, error: 'Ошибка запроса' },
    ]} />);
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(container.querySelector('script, img, iframe')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Получаем ответ…');
    expect(screen.getByRole('alert')).toHaveTextContent('Ошибка запроса');
  });
});
