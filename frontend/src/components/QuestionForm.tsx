import type { FormEvent, ReactElement } from 'react';

interface QuestionFormProps {
  question: string;
  isSubmitting: boolean;
  onQuestionChange: (question: string) => void;
  onSubmit: () => void;
}

export function QuestionForm({ question, isSubmitting, onQuestionChange, onSubmit }: QuestionFormProps): ReactElement {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <form className="question-form" onSubmit={handleSubmit}>
      <div className="field-heading">
        <label htmlFor="question">Ваш вопрос</label>
        <span className="character-count">Символов: {question.length.toLocaleString('ru-RU')}</span>
      </div>
      <textarea
        id="question"
        name="question"
        value={question}
        onChange={(event) => onQuestionChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="Опишите задачу или задайте уточняющий вопрос…"
        rows={4}
        required
        disabled={isSubmitting}
        aria-describedby="question-hint"
      />
      <div className="form-footer">
        <span id="question-hint" className="keyboard-hint">Ctrl / ⌘ + Enter — отправить</span>
        <button type="submit" disabled={isSubmitting || !question.trim()}>
          {isSubmitting ? 'Отправляем…' : 'Отправить'}
          {!isSubmitting && <span aria-hidden="true">↗</span>}
        </button>
      </div>
    </form>
  );
}
