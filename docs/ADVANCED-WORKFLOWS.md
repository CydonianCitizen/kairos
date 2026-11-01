# Permessi granulari, background, memoria e rewind

## Regole dei permessi

In `~/.kairos/config.json` oppure nel progetto fidato `.kairos/config.json`:

```json
{
  "permissions": {
    "edits": "ask",
    "shell": "ask",
    "external": "ask",
    "rules": [
      { "kind": "edits", "pattern": "src/**", "mode": "allow" },
      { "kind": "edits", "pattern": "**/*.env", "mode": "deny" },
      { "kind": "shell", "pattern": "npm test", "mode": "allow" },
      { "kind": "external", "pattern": "documentation:*", "mode": "ask" }
    ]
  }
}
```

I percorsi sono relativi al workspace e comprendono i target canonici dei file preparati, così un alias symlink non aggira una regola. Su Windows il confronto dei percorsi ignora maiuscole/minuscole. `*` e `?` lavorano nel segmento; `**` è un segmento che copre directory. Le chiamate esterne usano i nomi effettivi, per esempio `server:tool` per MCP e il nome registrato per un plugin. Le risorse MCP usano `server:resources`; i comandi plugin usano il proprio nome.

Ogni target del batch viene valutato prima del primo effetto. Fra regole coincidenti prevalgono `deny`, poi `ask`, poi `allow`; un `deny` della categoria blocca comunque i suoi effetti. In assenza di regole specifiche vale la categoria. I livelli personale/progetto/CLI uniscono le regole granulari senza cancellare i deny personali; le categorie mantengono la precedenza CLI → progetto fidato → personale. Sono consentite al massimo 128 regole complessive con pattern fino a 512 caratteri, entro il limite JSON di 32 KiB.

Le regole shell confrontano l'intero comando. Le autorizzazioni con wildcard parziali non accettano espansioni, sostituzioni, redirezioni, separatori o nuove righe; questi casi ricadono sulla policy normale. Un comando composto scritto esattamente nella regola può essere autorizzato esplicitamente. Il pattern shell `*` è una scelta deliberata di autorizzazione ampia. Queste regole controllano l'invocazione del tool, non tutti gli effetti possibili di un programma: un permesso su `edits` non è una regola del filesystem per Bash o plugin.

La CLI resta `ask` per default. Il non interattivo restituisce `approval_required` quando manca un handler. L'SDK conserva il default compatibile `allow`, salvo regole esplicite. Plan blocca avvio shell ed edit anche quando la sessione plan viene ripresa direttamente tramite SDK.

## Isolamento opzionale della shell

`--sandbox required`, oppure `"sandbox": "required"` nel JSON, richiede **Linux/WSL2 con bubblewrap**. KAIROS usa namespace separati per rete, processi e IPC, root filesystem in sola lettura, workspace scrivibile e `/tmp` privato. Rimuove le credenziali d'ambiente dal processo isolato. Le letture del filesystem host restano possibili: questo profilo limita scritture e rete, non rende privati tutti i file leggibili dall'account. Le opzioni del backend sono documentate nel [manuale ufficiale bubblewrap](https://github.com/containers/bubblewrap/blob/main/bwrap.xml).

Il backend non viene installato automaticamente. Se binario, namespace o piattaforma non sono disponibili, il comando fallisce e non viene eseguita una versione senza isolamento. Windows nativo e macOS non hanno un backend filesystem/rete incluso in questa versione; `required` li rifiuta. Il default `off` mantiene il comportamento esistente. `AgentOptions.shellInvocation` consente a un host SDK fidato di fornire il proprio wrapper; quel wrapper resta responsabilità dell'host.

## Processi in background

```text
/tasks
/tasks start npm run build
/tasks logs ID
/tasks stop ID
/tasks stop all
```

L'avvio passa dalla stessa policy shell e dalla stessa anteprima dei comandi ordinari. Il modello usa `run_bash` con `background: true`; ottiene immediatamente un ID dopo l'avvio supervisionato e continua il turno. `background_tasks_batch` permette richieste `list`, `logs` e `stop` senza inferenze aggiuntive per l'operazione locale. Non dichiarare riuscito un task ancora `running`.

Ogni task conserva stato, PID, tempi, exit code e fino a 15.000 caratteri per ciascuno di stdout/stderr, con indicazione del troncamento. Stati: `running`, `completed`, `failed`, `cancelled`, `timed_out`. Sono consentiti otto task attivi e conservati i 50 risultati completati più recenti. Timeout predefinito 30 secondi, configurabile fino a 300.000 ms tramite tool/SDK. Cancellare il turno dopo l'avvio non annulla un task già affidato al supervisore; usare stop o chiudere KAIROS.

La chiusura attende l'arresto delle risorse possedute. Su Windows la supervisione usa un Job Object e un helper nativo generato dalle API di sistema; la shell entra nel job prima dell'esecuzione e tutti i discendenti rimangono nel job. È richiesta la toolchain .NET disponibile tramite Windows PowerShell; errori di preparazione non avviano una shell non supervisionata. Su POSIX si supervisiona il gruppo di processi: un programma che esce deliberatamente dal gruppo con una nuova sessione richiede contenimento OS, come il backend Linux obbligatorio. I task sono in memoria, non vengono riavviati dopo la chiusura e non sono una coda NIM.

Elenco, log e stop sono disponibili anche mentre il turno è attivo. Cambiare sessione e ripristinare file è bloccato finché ci sono task in esecuzione. La barra di stato mostra il numero aggiornato; RPC emette `background_tasks` con metadati, senza duplicare i log.

## Memoria del progetto e istruzioni annidate

```text
/memory
/memory add Preferisci modifiche piccole e test mirati.
/memory update ID Nuova preferenza verificata.
/memory remove ID
/memory clear
```

La CLI abilita una memoria separata per ogni percorso canonico del progetto, in `~/.kairos/memory/<hash>/notes.json`. Una nuova sessione dello stesso progetto legge le note; una cartella diversa usa un archivio diverso. La memoria è distinta dai riassunti della conversazione e dalla preferenza globale dell'ultimo modello. `--no-memory` o `"memory": false` la disabilita. L'SDK la abilita esplicitamente con `memory: {directory?}`.

Il modello può proporre preferenze, correzioni e convenzioni stabili con `memory_update_batch`. È un tool batch del turno ordinario, non un riassunto automatico che consuma richieste aggiuntive. Le proposte vengono validate prima dell'anteprima e seguono la policy `edits`, con target virtuale `.kairos/memory`. L'approvazione è legata allo stato della memoria: una modifica intervenuta nel frattempo invalida la proposta. I comandi manuali sono richieste esplicite dell'utente.

Limiti: 50 note, 2.000 caratteri per nota, archivio fino a 32 KiB, contesto iniettato fino a 4.000 caratteri nel loop. Le note hanno ID e date stabili; sono trattate come dati e non concedono permessi. Credenziali riconoscibili, chiavi private e sorgenti grezzi vengono rifiutati; non inserire segreti nelle note. Il formato corrotto viene segnalato e preservato. Scritture atomiche, backup `.bak`, serializzazione fra processi e permessi richiesti 0700/0600 proteggono gli aggiornamenti. Serve un filesystem locale con hard link; nessuna cifratura applicativa o cancellazione automatica.

Con `--trust-workspace`, KAIROS carica gli `AGENTS.md` antenati delle fonti pertinenti, dalla radice alla directory più specifica. Vale per riferimenti espliciti, percorsi indicati nel prompt o nello steering e file/simboli letti dai tool. I documenti sono limitati a 32 KiB ciascuno e il contesto annidato a 4.000 caratteri nel loop. Traversal e symlink esterni non caricano istruzioni. Senza fiducia il caricamento annidato resta disattivato.

## Rewind per prompt

`/rewind` apre un selettore ricercabile dei prompt precedenti. ↑/↓ scelgono il punto, ←/→ cambiano ambito (`both`, `conversation`, `files`), Invio procede, Esc annulla. La CLI diretta accetta anche:

```text
/rewind ID conversation
/rewind ID files
/rewind ID both
```

Il punto rappresenta lo stato **prima** del prompt selezionato. `conversation` ripristina messaggi, riassunto, modello e modalità della sessione; `files` ripristina solo gli edit registrati e aggiunge alla conversazione un avviso che i vecchi risultati tool potrebbero non descrivere più i file; `both` combina i due. La preferenza globale dell'ultimo modello e la memoria del progetto non vengono riavvolte.

I file richiedono anteprima e permessi di edit. Il ripristino verifica l'intero insieme prima del primo effetto: contenuti, modalità, identità e percorsi, catena delle modifiche e appartenenza ai turni selezionati. Modifiche successive dell'utente o di un'altra sessione sui target coinvolti provocano un rifiuto. Ripristinare un file creato dall'agente può rimuoverlo, ma soltanto dopo questi controlli e la policy configurata. Non vengono usati reset Git.

Sono coperti solo gli edit del journal, non gli effetti di shell, plugin o MCP. Un undo interrotto va completato prima di scegliere un intervallo diverso. Il ripristino aggregato conserva un intento durevole e può riprendere dopo un'interruzione senza consumare batch estranei. Se un errore avviene dopo la fase file, il journal conserva l'esito: verificare il messaggio e riprovare il punto, senza ripetere alla cieca gli edit.

Si conservano fino a 100 punti e 32 MiB per archivio. Le sessioni persistenti usano `~/.kairos/rewind`; `--no-session` mantiene i punti soltanto in memoria. Vecchie sessioni prive di punti restano leggibili e iniziano a registrarli dai nuovi turni. I journal e i punti contengono sorgenti/conversazioni: conservarli come dati locali privati. Lo scrollback del terminale rimane una cronologia e non viene cancellato dal rewind.

## RPC e SDK

| RPC | Parametri |
| --- | --- |
| `tasks` | nessuno |
| `startTask` | `command`, `timeoutMs?` |
| `taskLogs`, `stopTasks` | `ids: string[]` |
| `memory` | nessuno |
| `updateMemory` | `changes: {action, id?, text?}[]` |
| `clearMemory` | nessuno |
| `rewindPoints` | nessuno |
| `rewind` | `id`, `scope?: conversation|files|both` |

Nell'SDK, `AgentLoop` espone `backgroundTasks`, `startBackground`, `listMemory`, `updateMemory`, `clearMemory`, `listRewinds` e `rewind`; `onBackgroundUpdate` emette i metadati correnti. Il supervisore e gli store sono esportati separatamente per gli host che ne gestiscono direttamente il ciclo di vita. Per il rewind dei file l'SDK deve fornire `undoDirectory`; per punti persistenti anche una sessione persistente e, opzionalmente, `rewindDirectory`. Le API locali non fanno chiamate NIM per elencare, fermare, modificare note o riavvolgere.
