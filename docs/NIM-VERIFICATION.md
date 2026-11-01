# Verifica hosted NIM — 1 novembre 2026

Eseguita con il client KAIROS, lo stesso pacing condiviso e una chiave locale configurata. Tutti i messaggi sono sintetici: nessun file del repository è stato inviato. Il limite è 45000 ms per richiesta, inclusa l'attesa in coda.

| Modello | Streaming e system prompt | Tool batch e continuazione | Effort |
| --- | --- | --- | --- |
| `mistralai/mistral-large-4-1t-a52b` | Passati | Passati | `none` e `high` passati dopo la correzione descritta sotto |
| `deepseek-ai/deepseek-v4.1-flash` | Timeout a 45 s | Saltati dopo il timeout | Nessun profilo esplicito configurato |
| `minimaxai/minimax-m3.1-flash` | Passati | Passati | `low`, `medium`, `high`, `xhigh`, `max` passati |
| `z-ai/glm-5.3-flash` | Timeout a 45 s | Saltati dopo il timeout | Nessun profilo esplicito configurato |
| `nvidia/nemotron-3.5-bolt-e4b` | Passati | Passati | Solo comportamento predefinito |

Il primo controllo Mistral ha riprodotto HTTP 400 con `reasoning_effort: "none"`; una seconda richiesta diagnostica ha confermato lo stesso errore. L'omissione del parametro aveva funzionato, e la [documentazione NVIDIA](https://docs.api.nvidia.com/nim/reference/mistralai-mistral-large-4-1t-a52b-infer) la descrive come default senza reasoning. Il client ora traduce la scelta `none` nell'omissione del campo. Il controllo Mistral ripetuto dopo la correzione ha passato tutte le prove.

Rapporti conservati:

- [Prima esecuzione sui cinque profili](NIM-LIVE-CHECKS-2026-11-01.json), compreso il HTTP 400 iniziale.
- [Ripetizione Mistral dopo la correzione](NIM-LIVE-CHECKS-2026-11-01-mistral.json).

I timeout DeepSeek/GLM non dimostrano assenza di supporto: quelle capacità restano non verificate con questa scadenza. Il controllo dei tool usa una chiamata batch con array e una continuazione che deve restituire il marcatore ricevuto dal risultato del tool; non certifica tutti gli schemi tool o il parallelismo. I controlli effort provano la riuscita della richiesta corrispondente, non misurano la quantità o qualità del ragionamento.

Per ripetere le verifiche con una scadenza diversa:

```sh
kairos --check-models --model deepseek-ai/deepseek-v4.1-flash --timeout-ms 90000
kairos --check-models --model z-ai/glm-5.3-flash --timeout-ms 90000
```

Il file personale `~/.kairos/model-checks.json` contiene l'ultima esecuzione; i rapporti in questa directory conservano i risultati di questa verifica. Credenziali e corpi di errore del provider non vengono inclusi.
