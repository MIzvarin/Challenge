import { useEffect, useRef, useState } from 'react';
import { askQuestion } from './api';
import type { Answer } from './api';
import { AnswerPanel } from './components/AnswerPanel';
import { QuestionForm } from './components/QuestionForm';

export function App() {
  const [question, setQuestion] = useState('');
  const [response, setResponse] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const activeRequest = useRef<{ controller: AbortController; timeout: number } | null>(null);

  useEffect(() => () => {
    if (activeRequest.current) {
      window.clearTimeout(activeRequest.current.timeout);
      activeRequest.current.controller.abort();
    }
    activeRequest.current = null;
  }, []);

  async function handleSubmit() {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || trimmedQuestion.length > 4000 || activeRequest.current) return;

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 60_000);
    const request = { controller, timeout };
    activeRequest.current = request;
    setIsSubmitting(true);
    setResponse(null);
    setError(null);

    try {
      const answer = await askQuestion(trimmedQuestion, controller.signal);
      if (activeRequest.current === request) setResponse(answer);
    } catch (cause) {
      if (activeRequest.current === request) {
        setError(controller.signal.aborted
          ? 'Время ожидания истекло. Попробуйте ещё раз.'
          : cause instanceof TypeError
            ? 'Нет связи с сервером. Проверьте подключение и запуск бэкенда.'
            : cause instanceof Error ? cause.message : 'Не удалось получить ответ. Попробуйте ещё раз.');
      }
    } finally {
      window.clearTimeout(timeout);
      if (activeRequest.current === request) {
        activeRequest.current = null;
        setIsSubmitting(false);
      }
    }
  }

  return (
    <main className="page">
      <header className="page-header">
        <a className="brand" href="/" aria-label="Challenge — на главную">challenge<span aria-hidden="true"> / </span>ai</a>
        <span className="provider-label">На базе OpenRouter</span>
      </header>
      <div className="workspace">
        <div className="intro">
          <p className="eyebrow">ПРОСТО СПРОСИТЕ</p>
          <h1>Вопрос — ответ.</h1>
          <p className="subtitle">Одна мысль, один вопрос. Остальное — за ИИ.</p>
        </div>
        <QuestionForm
          question={question}
          isSubmitting={isSubmitting}
          onQuestionChange={setQuestion}
          onSubmit={handleSubmit}
        />
        <AnswerPanel response={response} isSubmitting={isSubmitting} error={error} />
      </div>
      <footer className="page-footer">
        <span>Без истории. Без лишнего.</span>
        <span>Вопрос отправляется через OpenRouter провайдеру модели. Не указывайте секреты — ИИ может ошибаться.</span>
      </footer>
    </main>
  );
}
