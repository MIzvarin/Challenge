import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Answer } from '../api';
import type { Turn } from '../conversations';
import { makeAnswer, makeModelAnswer, makeTemperatureAnswer, withCosts } from '../test-fixtures';
import { AnswerPanel } from './AnswerPanel';

function turn(response: Answer): Turn {
  return { id: 'turn', question: response.question, date: response.date, response, error: null };
}

describe('AnswerPanel', () => {
  it.each([
    makeAnswer(), makeAnswer('Вопрос', 'direct', 'max'), makeTemperatureAnswer(),
    makeModelAnswer('Kimi'), makeModelAnswer('Grok', 'grok-4.7'), makeModelAnswer('GPT', 'gpt-6-luna'),
  ])('shows a price in every workspace: $question $model $effort', (answer) => {
    render(<AnswerPanel turns={[turn(withCosts(answer))]} />);
    expect(screen.getByText('Примерная стоимость: ≈ 0,001 USD')).toBeInTheDocument();
    expect(screen.getByText('1,3 сек.')).toBeInTheDocument();
    expect(screen.getByText('Токенов потрачено: 142')).toBeInTheDocument();
    expect(screen.queryByText('О расчёте стоимости')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Источник тарифа' })).not.toBeInTheDocument();
  });

  it('shows stage prices and comparison total, preserving partial successes', () => {
    const answer = withCosts(makeAnswer('Сравнить', 'compare'));
    const view = render(<AnswerPanel turns={[turn(answer)]} />);
    expect(screen.getByText('Примерная общая стоимость: ≈ 0,004 USD')).toBeInTheDocument();
    expect(screen.getAllByText('Примерная стоимость: ≈ 0,001 USD')).toHaveLength(4);
    expect(screen.getAllByText('Примерная стоимость: ≈ 0,0001 USD')).toHaveLength(3);
    answer.cost = null;
    answer.tokens = null;
    Object.assign(answer.results[3], { answer: null, error: 'Ошибка', tokens: null, cost: null });
    view.rerender(<AnswerPanel turns={[turn(answer)]} />);
    expect(screen.getByText('Общая стоимость недоступна')).toBeInTheDocument();
    expect(screen.getAllByText('Примерная стоимость: ≈ 0,001 USD')).toHaveLength(3);
    expect(screen.getByRole('alert')).toHaveTextContent('Ошибка');
  });

  it.each([undefined, null])('shows unknown legacy/null price %s without losing text', (cost) => {
    const answer = makeAnswer();
    answer.results[0].cost = cost;
    render(<AnswerPanel turns={[turn(answer)]} />);
    expect(screen.getByText('Стоимость недоступна')).toBeInTheDocument();
    expect(screen.getByText('Ответ модели')).toBeInTheDocument();
  });
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
