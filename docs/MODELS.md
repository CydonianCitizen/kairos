# Modelli NVIDIA NIM

Selezione verificata il **2026-10-31** sulle pagine ufficiali NVIDIA Build: tutti gli endpoint sotto risultano `Available` come Free Endpoint. È una fotografia del catalogo pubblico, non un controllo dell'accesso del singolo account né un test di inferenza reale. Il catalogo locale non si aggiorna automaticamente.

| ID API | Temperature | Top P | Budget output | Parallel tool calls |
| --- | --- | --- | --- | --- |
| [`mistralai/mistral-large-4-1t-a52b`](https://build.nvidia.com/mistralai/mistral-large-4-1t-a52b) — predefinito | 0.5 | 1 | 4096 | Ometti parametro |
| [`deepseek-ai/deepseek-v4.1-flash`](https://build.nvidia.com/deepseek-ai/deepseek-v4.1-flash) | 1 | 0.95 | 16384 | Ometti parametro |
| [`minimaxai/minimax-m3.1-flash`](https://build.nvidia.com/minimaxai/minimax-m3.1-flash) | 1 | 0.95 | 16384 | Ometti parametro |
| [`z-ai/glm-5.3-flash`](https://build.nvidia.com/z-ai/glm-5-3-flash) | 0.5 | 1 | 16384 | Ometti parametro |
| [`nvidia/nemotron-3.5-bolt-e4b`](https://build.nvidia.com/nvidia/nemotron-3.5-bolt-e4b) | 1 | 0.95 | 16384 | `true`, con tool |

Gli ID sono quelli degli esempi API NVIDIA: possono differire dagli slug delle pagine (ad esempio `glm-5.3-flash`). I parametri di campionamento seguono gli esempi pubblicati. I budget output sono scelte dell'applicazione, non i massimi degli endpoint: 4096 per Mistral senza reasoning esplicito, 16384 per lasciare spazio al reasoning degli altri modelli. Un budget esaurito può comunque troncare la risposta. Questi valori non modificano il limite del contesto dell'agente.

Il flag parallelo resta conservativo dove non è documentato; ometterlo non disabilita i normali tool. Il client consente override espliciti dei parametri per richiesta e `parallelToolCalls` nel costruttore. Gli ID personalizzati usano i fallback `temperature: 0.2`, `max_tokens: 4096`, senza `top_p` o `parallel_tool_calls` automatici.

Secondo la [documentazione Mistral NIM](https://docs.api.nvidia.com/nim/reference/mistralai-mistral-large-4-1t-a52b-infer), omettere `reasoning_effort` usa `none`; `high` è disponibile nelle richieste SDK ma non viene imposto dal profilo. L'agente conserva il campo NIM `reasoning_content` nella cronologia inviata al provider, separato dal testo visualizzato. La presenza di modelli multimodali nel catalogo non aggiunge input immagini alla CLI.

## Selezione

Dopo `npm run build`, avvia dalla radice del progetto:

```sh
node dist/cli.js --mode plan --model mistralai/mistral-large-4-1t-a52b
```

Nella TUI:

```text
/model
/model deepseek-ai/deepseek-v4.1-flash
```

Le sessioni esistenti conservano il modello salvato: usa `/model` per cambiarlo. Gli ID fuori catalogo restano accettati, ma la loro disponibilità dipende da NVIDIA. Il limite condiviso di 1600 ms tra richieste e i retry 429 restano applicati a tutti i modelli.
