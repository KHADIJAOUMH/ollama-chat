
const modelSelect = document.getElementById("model-select");
const chatMessages = document.getElementById("chat-messages");
const chatForm = document.getElementById("chat-form");
const messageInput = document.getElementById("message-input");

const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const newChatBtn = document.getElementById("new-chat-btn");

const thinkContainer = document.getElementById("think-container");
const thinkToggle = document.getElementById("think-toggle");
const statusMessage = document.getElementById("status-message");
const systemPromptInput =
  document.getElementById("system-prompt");

const temperatureInput =
  document.getElementById("temperature");

const temperatureValue =
  document.getElementById("temperature-value");

// Mémoire de conversation
let history = [];

// Contrôleur de la requête en cours
let controller = null;

// Capacités des modèles disponibles
let models = [];

// Afficher un message dans le chat
function addMessage(role, content = "") {
  const bubble = document.createElement("div");

  bubble.classList.add("message");
  bubble.classList.add(
    role === "user" ? "user-message" : "assistant-message"
  );

  bubble.textContent = content;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  return bubble;
}

// Afficher une erreur ou un état
function setStatus(text) {
  statusMessage.textContent = text;
}

// Gérer les boutons pendant la génération
function setGenerating(active) {
  messageInput.disabled = active;
  modelSelect.disabled = active;
  sendBtn.disabled = active;
  stopBtn.disabled = !active;
  newChatBtn.disabled = active;
  thinkToggle.disabled = active;
}

// Charger la liste des modèles
async function loadModels() {
  try {
    const response = await fetch("/api/models");

    if (!response.ok) {
      throw new Error("Impossible de charger les modèles.");
    }

    models = await response.json();
    modelSelect.replaceChildren();

    if (models.length === 0) {
      setStatus("Aucun modèle Ollama installé.");
      return;
    }

    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.name;
      option.textContent = model.name;
      modelSelect.appendChild(option);
    }

    updateThinkingOption();

  } catch (error) {
    setStatus(error.message);
  }
}

// Activer le raisonnement seulement si disponible
function updateThinkingOption() {
  const selected = models.find(
    model => model.name === modelSelect.value
  );

  const supportsThinking =
    selected?.capabilities?.includes("thinking") ?? false;

  thinkContainer.hidden = !supportsThinking;

  if (!supportsThinking) {
    thinkToggle.checked = false;
  }
}

// Lire un flux NDJSON progressivement
async function* readNDJSON(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line.trim()) {
          yield JSON.parse(line);
        }
      }
    }

    buffer += decoder.decode();

    if (buffer.trim()) {
      yield JSON.parse(buffer);
    }

  } finally {
    reader.releaseLock();
  }
}

// Envoyer un message
async function sendMessage(event) {
  event.preventDefault();

  const text = messageInput.value.trim();

  if (!text || controller) {
    return;
  }

  if (!modelSelect.value) {
    setStatus("Veuillez sélectionner un modèle.");
    return;
  }

  setStatus("");

  // Préparer le message utilisateur
  const userMessage = {
    role: "user",
    content: text
  };

  // Construire la conversation à envoyer
  const systemPrompt = systemPromptInput.value.trim();

const messagesToSend = [];

if (systemPrompt) {
  messagesToSend.push({
    role: "system",
    content: systemPrompt
  });
}

messagesToSend.push(...history, userMessage);

  // Afficher immédiatement le message utilisateur
  const welcome = chatMessages.querySelector(".welcome-message");
  if (welcome) {
    welcome.remove();
  }

  const userBubble = addMessage("user", text);
  const assistantBubble = addMessage("assistant", "");
  const answerText = document.createElement("div");
assistantBubble.appendChild(answerText);

  messageInput.value = "";

  let answer = "";
  let thinking = "";
  let completed = false;
  let stats = null;

  // Éléments du panneau de raisonnement
  let thinkingDetails = null;
  let thinkingText = null;

  const selectedModel = models.find(
    model => model.name === modelSelect.value
  );

  const body = {
  model: modelSelect.value,
  messages: messagesToSend,
  stream: true,
  options: {
    temperature: Number(temperatureInput.value)
  }
};

  if (selectedModel?.capabilities?.includes("thinking")) {
    body.think = thinkToggle.checked;
  }

  controller = new AbortController();
  const signal = controller.signal;

  setGenerating(true);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));

      throw new Error(
        errorData.error || "Erreur du serveur."
      );
    }

    // Parcourir les objets JSON reçus
    for await (const chunk of readNDJSON(response)) {
      if (chunk.error) {
        throw new Error(chunk.error);
      }

      // Texte normal de la réponse
      if (chunk.message?.content) {
        answer += chunk.message.content;
        answerText.textContent = answer;
      }

      // Texte de raisonnement
      if (chunk.message?.thinking) {
        thinking += chunk.message.thinking;

        if (!thinkingDetails) {
          thinkingDetails = document.createElement("details");
          thinkingDetails.className = "thinking-details";

          const summary = document.createElement("summary");
          summary.textContent = "Raisonnement du modèle";

          thinkingText = document.createElement("pre");
          thinkingText.style.whiteSpace = "pre-wrap";

          thinkingDetails.append(summary, thinkingText);
          assistantBubble.appendChild(thinkingDetails);
        }

        thinkingText.textContent = thinking;
      }

      // Statistiques de fin de génération
      if (chunk.done) {
        completed = true;

        if (chunk.eval_count && chunk.eval_duration) {
          stats = chunk.eval_count /
            (chunk.eval_duration / 1_000_000_000);
        }
      }

      chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    if (!completed) {
      throw new Error("Le flux s'est terminé prématurément.");
    }

    // Enregistrer les messages dans l'historique
    history.push(userMessage);
    history.push({
      role: "assistant",
      content: answer,
      ...(thinking ? { thinking } : {})
    });

    if (stats !== null) {
      setStatus(`Vitesse : ${stats.toFixed(2)} tokens/s`);
    }

  } catch (error) {
    if (signal.aborted) {
      // Garder la réponse partielle si elle existe
      if (answer || thinking) {
        history.push(userMessage);
        history.push({
          role: "assistant",
          content: answer,
          ...(thinking ? { thinking } : {})
        });

        setStatus("Génération arrêtée.");
      } else {
        userBubble.remove();
        assistantBubble.remove();
        setStatus("Génération annulée avant toute réponse.");
      }

    } else {
      // Ne pas conserver un échange qui a échoué
      userBubble.remove();
      assistantBubble.remove();
      setStatus(`Erreur : ${error.message}`);
    }

  } finally {
    controller = null;
    setGenerating(false);
    messageInput.focus();
  }
}

// Bouton Stop
stopBtn.addEventListener("click", () => {
  if (controller) {
    controller.abort();
  }
});

// Bouton Nouvelle conversation
newChatBtn.addEventListener("click", () => {
  history = [];
  chatMessages.replaceChildren();
  setStatus("");
  messageInput.value = "";
  messageInput.focus();
});

// Changement de modèle
modelSelect.addEventListener("change", () => {
  updateThinkingOption();
});

// Envoi du formulaire
chatForm.addEventListener("submit", sendMessage);

// Charger les modèles dès l'ouverture de la page
loadModels();

temperatureInput.addEventListener("input", () => {
  temperatureValue.textContent = temperatureInput.value;
});