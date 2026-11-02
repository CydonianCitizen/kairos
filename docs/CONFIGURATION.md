# Configurazione personale di KAIROS

La chiave resta nell'ambiente oppure in un file `.env`, con precedenza ambiente → `.env` del workspace → `~/.kairos/.env`. Non inserire credenziali nei file JSON: impostazioni sconosciute come `apiKey` vengono rifiutate.

## Chiave API globale

Avviare `kairos` e usare `/key`, senza argomenti. Il pannello maschera il valore: Invio salva, Esc annulla. Senza chiave configurata il pannello si apre automaticamente; annullare termina l'avvio.

La chiave viene salvata in `~/.kairos/.env` (`%USERPROFILE%\.kairos\.env` su Windows) e diventa subito attiva nel processo corrente. Il file è esterno al repository e viene caricato anche quando KAIROS parte in un'altra cartella. Le altre variabili e i commenti vengono conservati; prima di sostituire un file esistente se ne salva una copia esatta in `.env.bak`. I nuovi file usano permessi privati sui sistemi POSIX.

Il valore non entra nella cronologia dei prompt o nella conversazione, né viene inviato a NIM durante il salvataggio. Il salvataggio non verifica la validità della chiave presso NVIDIA. Al prossimo avvio restano valide le precedenze ambiente → `.env` del workspace → file personale: rimuovere gli override precedenti se si desidera usare sempre la chiave globale. Le modalità `--prompt`, `--rpc` e `--check-models` richiedono una chiave già configurata.

## Preferenze e istruzioni

Creare `~/.kairos/config.json` (`%USERPROFILE%\.kairos\config.json` su Windows):

```json
{
  "model": "mistralai/mistral-large-4-1t-a52b",
  "effort": "auto",
  "timeoutMs": 300000,
  "systemPromptFile": "system-prompt.md",
  "permissions": { "edits": "ask", "shell": "ask", "external": "ask" },
  "scope": "workspace"
}
```

Tutti i campi sono opzionali. Il modello deve avere formato `provider/model`; i livelli di effort devono essere supportati da quel modello. `timeoutMs` è un intero positivo fino a 2147483647. File JSON e istruzioni hanno un limite di 32 KiB ciascuno; errori di lettura, JSON malformato o impostazioni sconosciute interrompono l'avvio con un messaggio di configurazione.

Il file personale può contenere anche `plugins` (array di percorsi ESM) e `mcpServers` (oggetto di configurazioni MCP), insieme alle preferenze sopra. Queste sezioni vengono validate e caricate dall'host delle estensioni; i percorsi plugin relativi partono da `~/.kairos`. Le credenziali MCP devono riferirsi a variabili d'ambiente. La configurazione `.kairos/config.json` del progetto mantiene soltanto le preferenze; le estensioni del progetto fidato restano in `.nim/config.json`.

Scrivere le istruzioni personali in `~/.kairos/system-prompt.md`, per esempio:

```markdown
Rispondi in italiano. Preferisci modifiche piccole e coerenti con il progetto.
Esegui i controlli pertinenti e riporta quelli che non riesci a completare.
```

Questo percorso predefinito è letto anche senza `config.json` ed è opzionale. Se `systemPromptFile` è specificato esplicitamente, il file deve esistere. Le istruzioni vengono aggiunte al messaggio di sistema a ogni iterazione, anche dopo compattazione e ripresa della sessione. Il prompt base conserva le regole per tool batch, grafo e utilizzo NIM; il plan mode resta applicato dal dispatcher.

## Precedenza

Per nuove sessioni: **opzioni CLI → `.kairos/config.json` del progetto fidato → `~/.kairos/config.json` → valori inclusi**. La configurazione del progetto viene letta solo con `--trust-workspace`, lo stesso flag che autorizza `AGENTS.md`, skill e configurazione delle estensioni `.nim/`.

Per il **modello**, tra progetto fidato e configurazione personale si inserisce l'ultimo modello scelto manualmente. Selezioni con CLI, `/model`, picker o RPC vengono ricordate in `~/.kairos/last-model.json`, con copia precedente `.bak`, senza modificare `config.json`. La ripresa conserva il modello della sessione salvo override esplicito. I controlli `--check-models` e le selezioni automatiche del progetto non aggiornano questa preferenza. Un effort personale ereditato ma incompatibile con il nuovo modello passa ad `auto`.

`systemPromptFile` è relativo alla directory del JSON che lo definisce: in un progetto, `"../instructions.md"` punta al file nella radice del workspace. I prompt scelti dal progetto devono restare nel workspace, anche dopo risoluzione dei symlink. Le opzioni CLI possono selezionare esplicitamente file esterni. Il file di istruzioni vincente sostituisce quello personale come fonte aggiuntiva; non si concatenano più file di preferenze.

```sh
kairos --model mistralai/mistral-large-4-1t-a52b --effort high
kairos --system-prompt ./instructions.md
kairos --trust-workspace
kairos --timeout-ms 600000
```

La CLI risolve `--system-prompt` rispetto al workspace selezionato con `--cwd`. Per il timeout: `--timeout-ms` → `NVIDIA_TIMEOUT_MS` caricato dall'ambiente/`.env` → `timeoutMs` JSON → 300000 ms. La selezione modello/effort fatta nella TUI continua a essere salvata nella sessione; il JSON contiene i valori iniziali impostati dall'utente.

Le sessioni riprese conservano modello ed effort salvati, salvo `--model` e `--effort` espliciti. Le istruzioni sono rilette dai file a ogni avvio, così modificarle non richiede ricompilazione. L'SDK non legge automaticamente preferenze o `.env`: può chiamare `loadSettings()` e passare i campi a `createAgent()` o `AgentLoop`.

La CLI chiede approvazione per edit, shell e tool esterni. `permissions` accetta `allow`, `ask` o `deny` per categoria; `--permissions` imposta tutte e tre. Le categorie mancanti ereditano i livelli inferiori, poi `ask`. L'SDK mantiene `allow` salvo regole esplicite. La [guida ai flussi host](HOST-WORKFLOWS.md) descrive anteprime, undo persistente, riferimenti e coda dei messaggi.

`permissions.rules` aggiunge regole granulari `{kind, pattern, mode}` per percorsi, comandi completi e nomi dei tool esterni. Le regole si accumulano fra livelli e i deny prevalgono. `scope` definisce il perimetro operativo (`none`, `read-only`, `workspace` o `full`, con predefinito `workspace`); `--scope` da CLI o `/scope` nella TUI consentono di modificarlo. `none` disabilita ogni accesso a file e shell; `read-only` limita la lettura entro il workspace senza esporre tool di scrittura; `workspace` vincola letture e modifiche alla radice del progetto; `full` consente l'accesso all'intero dispositivo. `memory` accetta un booleano; `--no-memory` disabilita le note del progetto. `sandbox` accetta `off` o `required`; il secondo richiede il backend Linux/WSL2 con bubblewrap e non ripiega su esecuzione non isolata. Esempi, limiti e precedenze nella [guida avanzata](ADVANCED-WORKFLOWS.md).

In `none` non vengono letti o aggiunti nuovi contesti del repository: grafo, riferimenti `@file`/`@symbol`, istruzioni del workspace e note di progetto. La cronologia già presente resta parte della conversazione. Gli scope `none` e `read-only` bloccano anche background shell, ripristini di file ed effetti esterni; resta possibile fermare task già avviati. I permessi `ask/deny` si applicano anche agli edit esterni in `full`, che mantengono il journal undo. `AgentLoop.setScope()` richiede un agente inattivo, come `/scope` nella TUI; le anteprime filesystem vengono ricontrollate quando vengono applicate.

## Coordinamento NIM tra processi

Le istanze Kairos sullo stesso computer usano `~/.kairos/rate-limits` per coordinare una singola richiesta attiva e almeno 1600 ms tra gli avvii della stessa chiave. La chiave non viene scritta: i nomi dei file usano SHA-256. La lease resta acquisita durante streaming e backoff 429; il cooldown viene salvato anche prima dell'invio e quando una richiesta viene annullata. I processi terminati vengono recuperati conservando il cooldown.

Serve un filesystem locale con supporto agli hard link. Se il coordinatore è inaccessibile o corrotto, il client rifiuta la richiesta anziché inviarla senza protezione. Un PID ancora attivo non perde la lease perché è trascorso del tempo; il riuso di un PID può quindi mantenere prudenzialmente una coda bloccata. La FIFO vale nel singolo processo; l'ordine tra processi dipende dalla contesa del lock. Altre applicazioni e altri computer non partecipano al coordinamento. L'SDK può scegliere `rateLimitDirectory` nel costruttore di `NimClient`; processi che devono condividere il limite devono usare la stessa directory.

## Verifica esplicita dei modelli

```sh
kairos --check-models
kairos --check-models --model mistralai/mistral-large-4-1t-a52b
kairos --check-models --model mistralai/mistral-large-4-1t-a52b --timeout-ms 90000 --json
```

Senza `--model` vengono verificati i cinque profili inclusi. Il controllo è esplicito e usa richieste reali; non parte durante `npm test` o a ogni avvio. Le richieste usano lo stesso client e lo stesso coordinamento NIM dell'agente. I valori personali di modello/effort non cambiano le prove; `--effort` e `--system-prompt` non si combinano con questo comando, che usa istruzioni sintetiche e tutti i profili di effort già configurati per il modello.

I messaggi sono sintetici, senza sorgenti o istruzioni personali. Per ogni modello si controllano risposta completa in streaming, rispetto di un marcatore nel system prompt e chiamata a `echo_batch` con argomenti array, seguita da una continuazione con il risultato del tool. Sono provati anche tutti i livelli di effort esplicitamente configurati per quel modello. Un ciclo riuscito richiede tre richieste, più una per livello di effort diverso da `auto`.

Il limite predefinito è 45000 ms per singola richiesta, inclusa l'attesa in coda. `--timeout-ms` o `timeoutMs` JSON lo sostituiscono. `NVIDIA_TIMEOUT_MS` continua a controllare il timeout HTTP del client; i controlli hanno anche una propria scadenza complessiva per richiesta. I 429 conservano retry/backoff entro questa scadenza. `Ctrl+C` interrompe i controlli successivi.

Il report è salvato in `~/.kairos/model-checks.json`, con timestamp, modello, capacità verificata, durata ed eventuale stato HTTP. Non include chiave, intestazioni, sorgenti o corpi di errore del provider. I risultati sono `passed`, `failed` o `skipped`: un timeout o una risposta troncata non dimostrano che una capacità sia assente. Un controllo di effort riuscito dimostra che quella richiesta ha prodotto la risposta attesa, non che il backend abbia applicato un particolare algoritmo di ragionamento. Non vengono abilitate automaticamente nuove capacità nel catalogo.

`--json` restituisce il report su stdout e lascia avanzamento/percorso su stderr. Exit code 0 se tutte le prove eseguite passano; 1 se una prova fallisce. Gli endpoint non raggiungibili non ricevono le prove successive ridondanti.
