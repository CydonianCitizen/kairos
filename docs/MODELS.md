# Modelli NVIDIA NIM

Per verificare gli endpoint con la propria chiave: `kairos --check-models`, oppure `kairos --check-models --model provider/model`. Le richieste reali controllano streaming, istruzioni di sistema, tool batch e i livelli di effort configurati; i risultati con timestamp sono in `~/.kairos/model-checks.json`. Il controllo è esplicito, non avviene durante la suite di test, e non promuove automaticamente nuove capacità. Vedi [configurazione e verifiche](CONFIGURATION.md#verifica-esplicita-dei-modelli).

La [verifica hosted del 1 novembre 2026](NIM-VERIFICATION.md) ha completato streaming, istruzioni e tool su Mistral, MiniMax e Nemotron; DeepSeek/GLM hanno raggiunto la scadenza di 45 secondi. I rapporti registrano anche la verifica dei profili di effort e la correzione del parametro Mistral `none`.

Profili inclusi verificati il **2026-10-31** sulle pagine ufficiali NVIDIA Build: tutti gli endpoint sotto risultano `Available` come Free Endpoint. È una fotografia del catalogo pubblico, non un controllo dell'accesso del singolo account né un test di inferenza reale. Il selettore può includere altri modelli tramite l'aggiornamento automatico descritto sotto.

## Aggiornamento automatico

All'avvio della TUI, KAIROS scarica la lista da [`GET https://integrate.api.nvidia.com/v1/models`](https://integrate.api.nvidia.com/v1/models) se sono trascorse almeno **24 ore** dall'ultimo controllo. Negli altri avvii usa la cache in `~/.nim-codex/models.json` (`%USERPROFILE%\.nim-codex\models.json` su Windows). Il file contiene solo ID e timestamp, senza chiavi API. Il programma non richiede un servizio in background; la verifica successiva avviene al primo avvio dopo la scadenza.

La richiesta usa il client SDK e il limiter NIM condiviso, con timeout HTTP di 5 secondi e senza retry: un errore non blocca l'uso della lista precedente. Viene registrato anche il tentativo fallito per evitare nuove richieste a ogni riavvio nello stesso giorno. Se non esiste una cache valida, vengono usati i profili inclusi. Una cache corrotta viene ignorata; se il disco non è scrivibile, la lista scaricata rimane utilizzabile per l'avvio corrente.

Le richieste di inferenza attendono la risposta fino a **300.000 ms (5 minuti)**, anziché il precedente limite di 60 secondi. Impostare `NVIDIA_TIMEOUT_MS=600000` nell'ambiente o nel `.env` locale per un'attesa fino a 10 minuti; riavviare KAIROS dopo la modifica. L'opzione SDK `timeoutMs` ha precedenza. Il timeout SDK riguarda l'attesa della risposta HTTP, non un limite totale alla durata dello stream. Gli errori di timeout identificano modello e limite; non vengono ritentati automaticamente. Il catalogo mantiene il proprio limite di 5 secondi e il pacing NIM resta invariato. Un timeout più lungo non garantisce la disponibilità del servizio NVIDIA o le capacità dei modelli scaricati dal catalogo.

NVIDIA restituisce ID, senza metadati sufficienti per certificare il supporto ai tool. Il filtro esclude in modo euristico famiglie chiaramente estranee alla chat (embedding, reranker, reward, guard/safety, parser, CLIP, detector, DePlot, Riva, Ising e diffusion). Gli altri ID compaiono come candidati: la presenza nel catalogo non garantisce accesso dall'account, disponibilità dell'inferenza o tool calling. I profili noti mantengono i parametri verificati; per gli altri il client usa i fallback conservativi. Non vengono fatte chiamate di prova a ogni modello.

La risposta aggiornata sostituisce la lista precedente; il modello attivo della sessione rimane selezionabile anche se non compare nella risposta. L'aggiornamento non cambia automaticamente il modello della conversazione. `--help`, `--version`, CLI con prompt, JSON/RPC e import dell'SDK non avviano richieste di discovery; gli utilizzatori SDK possono chiamare esplicitamente `loadModelCatalog(client)`.

## Profili inclusi

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

Nella TUI, `/model` apre un selettore nel dock inferiore con il modello attivo evidenziato. Scrivi nel campo Search per filtrare i nomi, senza distinzione tra maiuscole e minuscole; Backspace corregge il filtro. Usa ↑/↓ per navigare fra i risultati, Invio per confermare ed Esc (o Ctrl+C) per tornare al prompt. Se non ci sono risultati, Invio non modifica il modello. La scelta è locale e non richiede chiamate NIM; la conferma aggiorna il modello mantenendo la conversazione. Per un ID personalizzato puoi usare il comando diretto:

```text
/model
/model deepseek-ai/deepseek-v4.1-flash
```

La TUI mostra il nome del modello senza il prefisso del provider (ad esempio `glm-5.3-flash`). Le richieste API, le sessioni e il comando diretto `/model provider/model` mantengono l'ID completo.

Le sessioni esistenti conservano il modello salvato: usa `/model` per cambiarlo. Gli ID fuori catalogo restano accettati, ma la loro disponibilità dipende da NVIDIA. Il limite condiviso di 1600 ms tra richieste e i retry 429 restano applicati a tutti i modelli.

## Reasoning effort

`/effort` apre un selettore navigabile con frecce e Invio; Esc o Ctrl+C annullano. Puoi anche usare `/effort high` oppure `/effort auto`. Il comando richiede un agente inattivo. `auto` omette il controllo e lascia il comportamento predefinito dell'endpoint.

| Modello | Livelli configurati | Parametro inviato |
| --- | --- | --- |
| Mistral Large 4 | `auto`, `none`, `high` | `high` usa `reasoning_effort`; `none` omette il campo |
| MiniMax M3.1 Flash | `auto`, `low`, `medium`, `high`, `xhigh`, `max` | `chat_template_kwargs.reasoning_effort` |
| Altri modelli, inclusi quelli scaricati | `auto` | Nessun parametro aggiunto |

Fonti: [API NIM Mistral](https://docs.api.nvidia.com/nim/reference/mistralai-mistral-large-4-1t-a52b-infer), [scheda NIM MiniMax](https://docs.api.nvidia.com/nim/reference/minimaxai-minimax-m3-1-flash), [payload della ricetta NVIDIA MiniMax](https://docs.dynamo.nvidia.com/dynamo/dev/recipes/minimax-m3-1). Il payload MiniMax segue il controllo nel chat template documentato da NVIDIA; tutti e cinque i livelli espliciti hanno completato la verifica hosted del 1 novembre 2026. Per gli altri endpoint non viene dedotto un formato dai soli ID del catalogo. La matrice si estende dopo aver verificato valori e trasporto specifici dell'endpoint.

Nella verifica hosted del **1 novembre 2026**, `reasoning_effort: "none"` su Mistral ha restituito HTTP 400, mentre l'omissione del campo e `high` hanno funzionato. KAIROS traduce quindi `none` nell'omissione del parametro, che la documentazione NVIDIA descrive come default senza reasoning. Non viene cambiato il significato dell'impostazione scelta dall'utente.

L'effort viene applicato a ogni richiesta del turno agente, incluse quelle successive ai tool. L'impostazione rimane separata dalla cronologia e viene salvata nel journal; le vecchie sessioni senza effort vengono aperte come `auto`. Un cambio modello mantiene il livello quando supportato, altrimenti torna ad `auto`. La compattazione usa i parametri predefiniti dell'endpoint e il suo budget ridotto.

Con Mistral `high`, KAIROS porta il budget output predefinito a 16384 token per lasciare spazio al reasoning; un `max_tokens` esplicito nell'SDK prevale. Il budget può comunque esaurirsi. L'SDK espone `agent.setEffort(livello)`, `agent.effort`, `effortLevels(model)` e `client.complete/stream({ ..., effort })`; non serve modificare la chiave API o la configurazione del workspace.
