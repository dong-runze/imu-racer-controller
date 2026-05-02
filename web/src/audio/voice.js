export function speakText(text, options = {}) {
  if (!window.speechSynthesis) {
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = options.lang || "zh-CN";
  utterance.rate = options.rate || 1.0;
  utterance.pitch = options.pitch || 1.0;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

export function speakOk() {
  speakText("OK", { lang: "en-US" });
}

export function requestVoiceConfirmation(stepTitle, handlers = {}) {
  speakText(`Ready to capture ${stepTitle}. Say OK or press confirm.`, {
    lang: "en-US",
  });

  return {
    confirm() {
      handlers.onConfirm?.();
    },
    cancel() {
      handlers.onCancel?.();
    },
  };
}
