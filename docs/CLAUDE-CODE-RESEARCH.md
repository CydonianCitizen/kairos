# Claude Code: ricerca sul codice pubblico e sui comportamenti

**Aggiornamento del 1 novembre 2026:** le sezioni 5–6 sotto descrivono il confronto storico del 31 ottobre. Diverse lacune sono state risolte: permessi per categoria, undo durevole, riferimenti e `/context`, session picker/rename/branch, preferenze globali e coda modificabile da tastiera. Per lo stato corrente usare [il confronto aggiornato](KAIROS-VS-CLAUDE-CODE.md).

Ricerca del **31 ottobre 2026**, finalizzata a capire cosa fa Claude Code e quali meccanismi possono essere utili a KAIROS. Questo documento contiene osservazioni e proposte, non nuove funzionalità implementate.

## 1. Perimetro e attendibilità

Repository esaminato: [`anthropics/claude-code`][repo], commit **`80c6959d28c4c30ecd14fc1cdf172f19d9adad81`**, datato 2026-10-31. I collegamenti al codice qui sotto sono fissati a quel commit; le pagine della documentazione possono cambiare successivamente.

**Il repository non contiene il sorgente completo della CLI.** Nell'albero esaminato ci sono esempi, configurazioni, automazioni e sorgenti di moduli incorporati, ma non l'implementazione completa del motore, del trasporto al modello e del renderer. Non è quindi possibile ricostruire tutta la CLI da questi file. Il repository pubblico non equivale a un progetto interamente open source: [LICENSE.md][license] rimanda ai termini commerciali Anthropic.

Il materiale pubblico è comunque sostanziale: [`mods/README.md`][mods] dichiara che i quattro moduli pubblicati sono inclusi nel binario. Le dichiarazioni dell'API sono generate da Claude Code **2.1.277** e marcate **early access**. La versione di quelle dichiarazioni non identifica necessariamente la versione di tutte le funzionalità descritte nelle pagine correnti. Non ho installato o eseguito Claude Code per questa ricerca.

Legenda:

- **Codice:** comportamento letto in sorgenti pubblici o nei relativi contratti e test; non prova dell'intera implementazione interna.
- **Documentazione:** comportamento dichiarato da Anthropic, senza ispezione del relativo codice interno.
- **KAIROS:** riscontro nel working tree locale, comprese le modifiche ancora non committate.
- **Proposta:** valutazione per KAIROS, non caratteristica verificata di Claude Code.

## 2. Dove si trova il codice utile

| Percorso pubblico | Cosa permette di studiare |
| --- | --- |
| [`mods/types/claude-code.d.ts`][types] | Contratti tipizzati di eventi, tool, sessioni, prompt, UI e ambiente dei function hook. Sono dichiarazioni, non il motore. |
| [`mods/diff/hooks/register.ts`][diff-register] | Stato del pannello diff, registrazione comando, eventi di refresh, apertura, chiusura e allegati al prompt. |
| [`mods/diff/hooks/views/pane-view.tsx`][diff-view] | Scelta fra pannello affiancato, dialogo inline e messaggio per terminale troppo stretto. |
| [`mods/diff/hooks/refresh-rest-of/refresh-rest-of.ts`][diff-rest] | Attesa adattiva dopo letture Git lente o scadute. |
| [`mods/agents-md/hooks/register.ts`][agents-register] | Caricamento delle istruzioni iniziali e annidate, integrazione con letture e agenti. |
| [`mods/agents-md/hooks/files/unseen-files.ts`][agents-unseen] | Deduplicazione delle istruzioni per percorso e contenuto. |
| [`mods/sec-default/hooks/register.ts`][security-register] | Protezione di policy e impostazioni gestite lungo la catena degli hook. |
| [`mods/telemetry/hooks/register.ts`][telemetry-register] | Integrazione della telemetria come modulo, filtro dei chiamanti e flush alla chiusura. |
| [`examples/hooks/bash_command_validator_example.py`][bash-hook] | Protocollo di un hook esterno: JSON in ingresso, validazione, exit code e feedback al modello. |
| [`.claude-plugin/marketplace.json`][marketplace] | Catalogo dichiarativo e riferimenti al repository dei plugin ufficiali. |

I plugin Anthropic sono ora sviluppati in `anthropics/claude-plugins-official`, come indicato dal [README][readme] e dal marketplace. Non va interpretata l'assenza del vecchio codice sotto `plugins/` come assenza di plugin nel prodotto.

## 3. Meccanismi verificabili nei moduli pubblici

### 3.1 Hook tipizzati e accesso mediato al motore

**Codice.** Un modulo espone `register(on, options)`. Registra funzioni che ricevono il motore `$`, l'evento `e` e la continuazione `next`. Può osservare un evento, modificare i dati passati a `next(e)` o rispondere secondo il contratto dell'evento. Non tutti gli eventi hanno le stesse facoltà di blocco o sostituzione. Il manifest e `hooks/hooks.json` collegano il plugin al modulo. [Contratti][types], [configurazione del diff][diff-hooks].

Il contratto dei **function hook** descrive un ambiente senza Node e senza DOM: filesystem, processi, rete e UI passano dalle interfacce del motore. Il JSX usa `h`/`Fragment`; gli elementi si ottengono dalla superficie tramite `$.ui.resolve(e)`. Questo non dimostra quale libreria implementi ogni parte della TUI interna e non significa che tutti gli hook esterni siano isolati allo stesso modo. [Dichiarazioni, righe iniziali][types].

**Proposta.** Il principio utile è avere punti di estensione precisi con argomenti e risultati validati. Non serve riprodurre l'intera API di Claude Code per aggiungere pochi hook a KAIROS.

### 3.2 Diff: eventi, stato locale e lavoro proporzionato alla vista

**Codice.** Il modulo `diff` conserva uno stato del pannello distinto dalla conversazione. I punti centrali sono `register`, `refresh`, `afterTool` e il gestore di `prompt.submit`:

1. A `session.start` registra il comando e collega i servizi del motore. Il backend Git viene individuato quando serve, evitando una scansione Git iniziale per un pannello inutilizzato.
2. Dopo un edit riuscito, o un comando che potrebbe avere scritto file anche se fallito/interrotto, `afterTool` richiede un aggiornamento della vista aperta. Non tratta un edit negato come modifica riuscita.
3. Le richieste ravvicinate vengono raggruppate: debounce del refresh di **150 ms**, invalidazione del disegno raggruppata su **100 ms**. Se una lettura è già in corso, ulteriori richieste confluiscono in una successiva, invece di avviare letture sovrapposte.
4. `refreshRestOf` impone una pausa proporzionata alla lettura precedente, fino a **30 s**. Dopo timeout consecutivi applica **10, 20, 40, 60 s**, con tetto a 60 s. Le interazioni esplicite possono saltare la pausa, mantenendo la serializzazione.
5. `paneView` sceglie la presentazione in base a collocazione, larghezza e stato della superficie. La scelta manuale di chiudere il pannello viene rispettata.
6. L'azione di domanda su un file prepara i suoi hunk per il prompt successivo. Il gestore li aggiunge entro un budget e disarma la selezione quando il prompt viene accettato; non inietta continuamente tutti i diff.

Fonti: [registrazione e ciclo di aggiornamento][diff-register], [rendering][diff-view], [debounce][diff-debounce], [ridisegno][diff-redraw], [attesa adattiva][diff-rest], [test dei ritardi][diff-rest-test]. Questi test sono stati letti, non eseguiti.

La [descrizione del modulo][diff-readme] distingue esplicitamente alcuni suoi comportamenti dal pannello interno preesistente. Le ottimizzazioni osservate in questo modulo non vanno attribuite automaticamente a ogni renderer/versione del prodotto.

**Proposta.** Per KAIROS sono applicabili refresh dopo effetti, accorpamento degli eventi, dati Git caricati su richiesta e allegati selettivi. Sono attività locali e non richiedono chiamate NIM. Il pannello affiancato fullscreen non è un requisito: KAIROS deve conservare la TUI inline e lo scrollback nativo.

### 3.3 Istruzioni: caricamento gerarchico e deduplicazione

**Codice.** Il modulo `agents-md` intercetta `prompt.context`, cerca le istruzioni lungo gli antenati del percorso e le inserisce tra i file di istruzioni del motore. L'opzione predefinita usa `AGENTS.md` quando il progetto non ha un proprio `CLAUDE.md`; altre opzioni permettono entrambi, solo `CLAUDE.md`, oppure solo istruzioni gestite. [Manifest][agents-manifest], [implementazione][agents-register].

Dopo una lettura riuscita, un hook `tool.call` su `Read` cerca istruzioni annidate pertinenti sotto la radice. Tiene traccia dei file già consegnati per agente e gestisce l'eredità di un fork. `unseenFiles` elimina duplicati per percorso normalizzato e per contenuto già presente nei file di progetto: evita di reiniettare lo stesso testo importato o collegato. Le letture senza allegati disabilitano questo arricchimento. [Caricamento][agents-register], [deduplicazione][agents-unseen].

**Proposta.** KAIROS legge attualmente l'`AGENTS.md` radice quando il workspace è autorizzato. Le istruzioni annidate sarebbero un'estensione utile, da applicare sia ai tool di lettura batch sia all'ispezione dei simboli, mantenendo il controllo dei percorsi.

### 3.4 Policy protette lungo la catena

**Codice.** `sec-default` si colloca all'esterno dei plugin utente e preserva impostazioni e policy dell'organizzazione. Usa provenienza e livello del chiamante, salta il livello utente per eventi protetti, rifiuta registrazioni incompatibili con policy e ricontrolla determinati verdetti modificati dai plugin. Non introduce da solo una policy e non è una sandbox del sistema operativo. [Sorgente][security-register], [perimetro e limiti dichiarati][security-readme].

**Proposta.** Eventuali hook KAIROS non devono poter aggirare plan mode o i controlli del dispatcher. I plugin ESM attuali restano codice fidato con i privilegi di Node: aggiungere callback non darebbe l'isolamento descritto dai function hook di Claude Code.

### 3.5 Hook esterni: il validatore Bash non riscrive il comando

**Codice.** Nell'esempio Python, `main` legge JSON da stdin e considera solo `Bash`; `_validate_command` applica espressioni regolari. Se trova `grep` o un particolare `find -name`, stampa suggerimenti su stderr ed esce con **2**. **Blocca** la chiamata e restituisce feedback: non sostituisce il comando con `rg`, nonostante la descrizione iniziale del file possa suggerirlo. [Esempio completo][bash-hook].

**Documentazione.** Gli hook classici hanno eventi come `PreToolUse`, `PostToolUse`, `Stop` e compattazione. Gli effetti di exit code e JSON dipendono dall'evento: un hook successivo a un tool non può annullare l'effetto già avvenuto. [Riferimento hook][doc-hooks].

**Proposta.** Un hook che forza una correzione del modello può costare una nuova richiesta NIM. Per semplici vincoli, privilegiare validazione deterministica e schemi dei tool già corretti.

### 3.6 Telemetria come consumatore degli eventi

**Codice.** Il modulo `telemetry` filtra l'origine delle chiamate, si collega a `engine.create` e svuota la coda a `session.end`. La sua descrizione documenta invio in batch, rispetto degli interruttori di disabilitazione e proprietà vincolate, anziché testo libero. Non è un componente necessario per disegnare la UI. [Registrazione][telemetry-register], [descrizione][telemetry-readme].

**Proposta.** È utile come esempio di un consumatore separato degli eventi. La ricerca non propone di aggiungere raccolta remota di dati a KAIROS.

## 4. Comportamenti del prodotto descritti ufficialmente

Questa sezione descrive contratti e UX documentati; non pretende di aver ispezionato il codice interno che li implementa.

| Area | Cosa fa e come viene esposto |
| --- | --- |
| Ciclo agente | Alterna raccolta del contesto, azione e verifica. I risultati dei tool alimentano le decisioni successive; l'applicazione gestisce strumenti e contesto intorno al modello. Non è una sequenza rigida di tre schermate. [Architettura][doc-how] |
| Menu comandi | `/` elenca e filtra comandi nativi, skill e contributi di plugin/MCP. Le disponibilità dipendono dalla configurazione. Il completamento nel mezzo di un prompt inserisce testo; eseguire un comando è distinto dal completarlo. [Interazione][doc-interactive] |
| Editor del prompt | Supporta testo multilinea e incolla. `Ctrl+J` e `\` seguito da Invio offrono alternative alle combinazioni dipendenti dal terminale; `Shift+Enter` non è universalmente distinguibile da Invio. [Terminale][doc-terminal] La cronologia è ricercabile con `Ctrl+R`. [Interazione][doc-interactive] |
| Messaggi durante il lavoro | Il testo accodato durante i tool può entrare nello stesso turno quando i tool terminano. Comandi e shell accodati normalmente attendono la fine del turno. Questa semantica differisce da una coda di soli turni successivi. [Interazione][doc-interactive] |
| Renderer | Le pagine correnti distinguono renderer classico e fullscreen, con scorciatoie diverse; `/tui` indica quello attivo. Non esiste un unico comportamento da copiare assumendo che sia sempre inline. [Interazione][doc-interactive] |
| Modello ed effort | `/model` permette anche di regolare l'effort sui modelli compatibili. Sono documentati override, preferenze per modello e momento di applicazione della scelta. `auto` può significare non inviare un livello. I valori e il formato della richiesta restano specifici del provider. [Modelli][doc-model] |
| Barra di stato | Una status line opzionale esegue un comando locale, gli passa JSON su stdin e visualizza stdout. Aggiornamenti avvengono all'avvio, su eventi come messaggi/compattazione e su timer configurabili; nessuna chiamata al modello è necessaria. È distinta dai badge del footer. [Status line][doc-status] |
| Sessioni | Trascrizioni locali salvate continuamente; ripresa per ID/nome, selettore ricercabile, rinomina e ramificazione. `/branch` copia la conversazione e usa un nuovo ID; non crea da solo isolamento Git dei file. [Sessioni][doc-sessions] |
| Contesto e compattazione | La cronologia viene riassunta e alcuni contenuti persistenti reiniettati. Istruzioni annidate/regole per percorso rientrano su richiesta; file recenti possono essere riletti. Corpo delle skill e descrizioni hanno politiche distinte. Compattare non equivale a cancellare indiscriminatamente le istruzioni. [Contesto][doc-context] |
| Ripristino | Checkpoint dei file modificati con gli strumenti di editing, insieme alla conversazione. `/rewind` separa ripristino di codice, conversazione e riassunto mirato. Esistono limiti per modifiche esclusivamente da shell, agenti e link: non è un backup generale del workspace. [Checkpoint][doc-checkpoints] |
| Permessi | Regole applicate dall'applicazione, con precedenza `deny`, poi `ask`, poi `allow`; modalità e autorizzazioni non dipendono dall'obbedienza del modello al prompt. Un diniego per l'intero tool può anche rimuoverlo dal contesto. [Permessi][doc-permissions] |
| Skill | `SKILL.md` con frontmatter: descrizione disponibile per la scoperta e corpo caricato quando invocato. Campi come `disable-model-invocation` e `user-invocable` distinguono uso automatico e manuale; sono previsti argomenti e file di supporto. [Skill][doc-skills] |
| Plugin | Pacchetto con manifest che aggrega skill, agenti, hook e server MCP. Le skill del pacchetto hanno nomi qualificati, ad esempio `/my-plugin:review`. I componenti possono esistere anche senza un plugin. [Plugin][doc-plugins] |
| MCP | Processi stdio e server remoti HTTP; autenticazione OAuth e gestione tramite `/mcp`. La ricerca dei tool può rinviare il caricamento delle definizioni, con compatibilità e fallback dipendenti da modello/gateway. [MCP][doc-mcp] |
| Subagenti | Contesto separato, prompt e strumenti dedicati; ritornano risultati sintetici al padre. Un fork può invece ereditare la conversazione. Consumano richieste proprie e gli stessi limiti di utilizzo: l'isolamento del contesto non elimina il costo API. [Subagenti][doc-agents] |
| Automazione e SDK | Modalità non interattiva, testo/JSON/JSONL, eventi parziali e risultato finale; output conforme a JSON Schema disponibile. L'Agent SDK espone strumenti, loop e gestione del contesto del prodotto. Questi formati non sono una promessa di compatibilità con il JSON-RPC di KAIROS. [Uso programmatico][doc-headless] |

## 5. Riscontro sul KAIROS attuale

Riferimenti locali relativi a questo documento. Sono osservazioni sul codice disponibile oggi, non un nuovo audit completo.

Aggiornamenti successivi alla ricerca: sono stati implementati l'[editor multilinea, la ricerca Ctrl+R, il selettore ricercabile `/resume`, `/rename`, `/branch` e `/btw`](../README.md#tui-inline-e-cli-fase-4). `/branch` copia e attiva una sessione; `/btw` usa un contesto laterale senza tool, con modello opzionale e coda NIM condivisa. Il confronto sotto conserva il punto di partenza precedente a questi interventi.

| Area | Già presente | Differenza concreta o punto da approfondire |
| --- | --- | --- |
| TUI e comandi | [`App.tsx`](../src/ui/App.tsx), [`PinnedLayout.tsx`](../src/ui/PinnedLayout.tsx), [`commands.ts`](../src/ui/commands.ts): input in basso, scrollback `Static`, menu `/`, modello ed effort. | [`InputBox.tsx`](../src/ui/InputBox.tsx) non implementa un editor multilinea dedicato né ricerca della cronologia dei prompt. |
| Input durante i tool | [`interaction.ts`](../src/core/interaction.ts): FIFO dei turni e cancellazione; [`agent-loop.ts`](../src/core/agent-loop.ts): steering ai confini dei gruppi di tool. | Invio normale accoda un turno successivo; `/steer` serve per intervenire nel turno attivo. Non sono semanticamente identici all'accodamento documentato di Claude Code. |
| Sessioni | [`session-store.ts`](../src/core/session-store.ts): JSONL, ripresa, lock e recupero delle scritture incomplete. | [`controller.ts`](../src/ui/controller.ts) elenca le sessioni e richiede un ID per `/resume`; mancano selettore ricercabile, titoli gestibili e branch della conversazione. |
| Compattazione | [`agent-loop.ts`](../src/core/agent-loop.ts): riassunto NIM, fallback locale, conservazione delle coppie tool/risultato. | Budget in caratteri; non c'è una vista `/context` dei consumi. Nessun recupero mirato dei file recenti dopo il riassunto. Le estensioni attive sono già aggiunte nuovamente alla richiesta: non vanno trattate come completamente assenti dopo la compattazione. |
| Diff e ripristino | [`DiffBlock.tsx`](../src/ui/DiffBlock.tsx): diff degli edit mostrati nella cronologia. | Mancano vista aggregata `/diff` e snapshot ripristinabili dei file. Il metodo `checkpoint()` del loop salva lo stato della sessione, non annulla modifiche al filesystem. |
| Sicurezza ed eventi | [`registry.ts`](../src/tools/registry.ts): validazione e rifiuto dei tool vietati in plan; eventi tipizzati del loop. | Nessun sistema generale di regole allow/ask/deny per operazione. Non confondere questi eventi informativi con un hook che può bloccare un tool prima dell'effetto. |
| Istruzioni e skill | [`host.ts`](../src/extensions/host.ts): `AGENTS.md` radice, elenco delle skill, caricamento batch e attivazione manuale, con workspace autorizzato. | Niente istruzioni annidate per directory; frontmatter limitato e nessun insieme completo dei controlli di invocazione di Claude Code. |
| Plugin | [`host.ts`](../src/extensions/host.ts): moduli ESM locali, tool, comandi e `onTurnEnd`. | Non ci sono manifest di pacchetto/marketplace, function hook isolati o lifecycle generale prima/dopo i tool. I plugin attuali non sono sandboxati. |
| MCP | [`mcp.ts`](../src/extensions/mcp.ts): stdio, Streamable HTTP, tool e risorse; schemi esterni caricati tramite `inspect_extension_tools`. | OAuth interattivo, elicitation e prompt MCP non sono implementati. La scoperta differita degli schemi è già presente e va mantenuta. |
| Integrazioni | [`rpc.ts`](../src/integrations/rpc.ts), [`index.ts`](../src/index.ts): JSON-RPC e SDK; CLI con JSONL. | Verificare caso per caso contratti, errori e capacità per integrazioni future. Avere JSON in entrambi i prodotti non rende intercambiabili i protocolli. |
| Subagenti e lavori in background | Un loop con coda condivisa delle richieste NIM. | Nessuna orchestrazione di subagenti o gestione generale di processi in background. Un eventuale sviluppo richiederebbe anche limiti di coda, cancellazione e proprietà delle risorse. |

## 6. Indicazioni da conservare per i prossimi interventi

Queste sono **proposte**, non lavoro avviato o un piano di implementazione approvato.

| Interesse per KAIROS | Cosa riprendere | Come adattarlo ai vincoli attuali |
| --- | --- | --- |
| Alto, interazione quotidiana | Multilinea, incolla, cronologia ricercabile e selettore sessioni. | Operazioni locali; alternative tastiera compatibili con Windows/macOS/Linux; apertura del selettore distinta dall'esecuzione del comando. |
| Alto, trasparenza | Vista del budget di contesto e diff aggregato su richiesta. | Rendere esplicita la stima finché il budget è in caratteri. Letture Git accorpate, limitate e avviate quando la vista serve. |
| Alto, controllo delle modifiche | Snapshot dei file e ripristino selettivo. | Conservare il contenuto precedente agli edit batch e verificare modifiche concorrenti prima di ripristinare. Non usare reset Git e non promettere annullamento degli effetti esterni. |
| Medio, estensibilità | Pochi hook prima/dopo i tool e istruzioni annidate. | Un unico passaggio nel dispatcher, validazione dei risultati e plan mode non aggirabile. Applicare le istruzioni anche ai simboli letti dal grafo. |
| Medio, connessioni reali | OAuth MCP e richieste interattive dei server. | Costruire sul client MCP già presente; credenziali fuori da Git e risposte gestibili anche via RPC, senza imporre la TUI all'SDK. |
| Successivo, costo maggiore | Subagenti e lavori in background. | Tutte le richieste, inclusi riassunti e retry, devono attraversare il limiter condiviso. Il limite attuale è per processo: più processi KAIROS con la stessa chiave non condividono automaticamente quel coordinamento. |

Non emerge la necessità di sostituire Ink, il client OpenAI/NIM o il Code Graph per ottenere queste capacità. Il grafo locale e i tool batch restano scelte coerenti con il limite di **40 RPM**. Copiare una strategia basata su molte esplorazioni autonome, hook valutati da modelli o subagenti senza budget aumenterebbe invece le richieste.

## 7. Cosa resta non verificato

- Implementazione completa del renderer, algoritmo di diff dello schermo e gestione interna del cursore: non disponibili nell'albero studiato. Non attribuire a Claude Code il nostro schema `Ink <Static> + PinnedLayout`.
- Prompt di sistema completo, scheduler interno e algoritmi interni di compattazione/session storage: i contratti pubblici e le guide descrivono parti del comportamento, non tutta l'implementazione.
- Funzionamento pratico della versione installabile su Windows, macOS e Linux: nessun test del prodotto Anthropic è stato eseguito qui.
- Compatibilità binaria dei plugin e delle API: la superficie dei function hook esaminata è sperimentale; non è una specifica stabile da adottare integralmente.

Non sono stati usati sorgenti trapelati, decompilati o mirror non ufficiali. Il codice applicativo di KAIROS non è stato modificato da questa ricerca.

[repo]: https://github.com/anthropics/claude-code/tree/80c6959d28c4c30ecd14fc1cdf172f19d9adad81
[license]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/LICENSE.md
[readme]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/README.md
[mods]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/mods/README.md
[types]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/mods/types/claude-code.d.ts
[diff-register]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/mods/diff/hooks/register.ts
[diff-view]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/mods/diff/hooks/views/pane-view.tsx
[diff-hooks]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/mods/diff/hooks/hooks.json
[diff-rest]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/mods/diff/hooks/refresh-rest-of/refresh-rest-of.ts
[diff-rest-test]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/mods/diff/tests/refresh-rest-of.test.ts
[diff-debounce]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/mods/diff/hooks/limits/timing/refresh-debounce-ms.ts
[diff-redraw]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/mods/diff/hooks/limits/timing/redraw-coalesce-ms.ts
[diff-readme]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/mods/diff/README.md
[agents-register]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/mods/agents-md/hooks/register.ts
[agents-unseen]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/mods/agents-md/hooks/files/unseen-files.ts
[agents-manifest]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/mods/agents-md/.claude-plugin/plugin.json
[security-register]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/mods/sec-default/hooks/register.ts
[security-readme]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/mods/sec-default/README.md
[telemetry-register]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/mods/telemetry/hooks/register.ts
[telemetry-readme]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/mods/telemetry/README.md
[bash-hook]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/examples/hooks/bash_command_validator_example.py
[marketplace]: https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/.claude-plugin/marketplace.json
[doc-how]: https://code.claude.com/docs/en/how-claude-code-works
[doc-interactive]: https://code.claude.com/docs/en/interactive-mode
[doc-terminal]: https://code.claude.com/docs/en/terminal-config
[doc-model]: https://code.claude.com/docs/en/model-config
[doc-status]: https://code.claude.com/docs/en/statusline
[doc-sessions]: https://code.claude.com/docs/en/sessions
[doc-context]: https://code.claude.com/docs/en/context-window
[doc-checkpoints]: https://code.claude.com/docs/en/checkpointing
[doc-permissions]: https://code.claude.com/docs/en/permissions
[doc-skills]: https://code.claude.com/docs/en/skills
[doc-plugins]: https://code.claude.com/docs/en/plugins
[doc-mcp]: https://code.claude.com/docs/en/mcp
[doc-agents]: https://code.claude.com/docs/en/sub-agents
[doc-headless]: https://code.claude.com/docs/en/headless
[doc-hooks]: https://code.claude.com/docs/en/hooks
