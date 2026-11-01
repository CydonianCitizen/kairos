import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ShellInvocation } from './shell-runner.js';

const payloadKey = 'KAIROS_OWNED_SHELL_JOB';
const source = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class KairosOwnedJob {
  static volatile bool Cancelled;
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public uint Size; public string Reserved, Desktop, Title; public uint X, Y, Width, Height, CharsX, CharsY, Fill, Flags;
    public ushort ShowWindow, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedStartup { public StartupInfo Basic; public IntPtr Attributes; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int information, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int information, out Accounting accounting, uint size, IntPtr returnedSize);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string file, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref ExtendedStartup startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateEvent(IntPtr attributes, bool manualReset, bool initialState, string name);
  [DllImport("kernel32.dll")] static extern bool SetEvent(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string file, uint access, uint share, IntPtr attributes, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool success, string operation) { if (!success) { int code = Marshal.GetLastWin32Error(); throw new Win32Exception(code, operation + ": " + new Win32Exception(code).Message); } }
  static void WaitEmptyJob(IntPtr job) {
    while (true) {
      Accounting accounting;
      Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "QueryInformationJobObject");
      if (accounting.ActiveProcesses == 0) return;
      Thread.Sleep(25);
    }
  }

  public static int Run(string file, string command, string directory, string ready, uint parentPid) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
    ProcessInfo process = new ProcessInfo();
    bool resumed = false;
    IntPtr attributes = IntPtr.Zero, jobValue = IntPtr.Zero, parent = IntPtr.Zero, finished = IntPtr.Zero, input = IntPtr.Zero;
    Thread watcher = null;
    try {
      ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "SetInformationJobObject");
      Thread controller = new Thread(delegate() { if (Console.ReadLine() == "stop") { Cancelled = true; TerminateJobObject(job, 125); } });
      controller.IsBackground = true; controller.Start();
      parent = OpenProcess(0x100000, false, parentPid); Check(parent != IntPtr.Zero, "OpenProcess(parent)");
      finished = CreateEvent(IntPtr.Zero, true, false, null); Check(finished != IntPtr.Zero, "CreateEvent");
      ExtendedStartup startup = new ExtendedStartup(); startup.Basic.Size = (uint)Marshal.SizeOf(typeof(ExtendedStartup));
      input = CreateFile("NUL", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero); Check(input != new IntPtr(-1), "Open command stdin");
      Check(SetHandleInformation(input, 1, 1), "SetHandleInformation");
      startup.Basic.Flags = 0x100; startup.Basic.Input = input; startup.Basic.Output = GetStdHandle(-11); startup.Basic.Error = GetStdHandle(-12);
      IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      attributes = Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size), "InitializeProcThreadAttributeList");
      jobValue = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue, job);
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobValue, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Job-list process attribute (Windows 10+ required)");
      startup.Attributes = attributes;
      if (Cancelled) return 125;
      Check(CreateProcess(String.IsNullOrEmpty(file) ? null : file, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 0x08080004, IntPtr.Zero, directory, ref startup, out process), "CreateProcess in owned job");
      watcher = new Thread(delegate() { if (WaitForMultipleObjects(2, new IntPtr[] { parent, finished }, false, UInt32.MaxValue) == 0) { TerminateJobObject(job, 125); Environment.Exit(125); } });
      watcher.IsBackground = true; watcher.Start();
      if (Cancelled) TerminateJobObject(job, 125);
      else {
        Console.Error.Write(ready + "\n"); Console.Error.Flush();
        Check(ResumeThread(process.Thread) != UInt32.MaxValue, "ResumeThread"); resumed = true;
      }
      Check(WaitForSingleObject(process.Process, UInt32.MaxValue) == 0, "WaitForSingleObject");
      uint exitCode; Check(GetExitCodeProcess(process.Process, out exitCode), "GetExitCodeProcess");
      WaitEmptyJob(job);
      return unchecked((int)exitCode);
    } catch {
      if (process.Process != IntPtr.Zero) { if (!resumed) TerminateProcess(process.Process, 125); TerminateJobObject(job, 125); WaitForSingleObject(process.Process, UInt32.MaxValue); WaitEmptyJob(job); }
      throw;
    } finally {
      if (finished != IntPtr.Zero) SetEvent(finished);
      if (watcher != null) watcher.Join();
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
      if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
      CloseHandle(job);
      if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
      if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
      if (finished != IntPtr.Zero) CloseHandle(finished);
      if (parent != IntPtr.Zero) CloseHandle(parent);
      if (input != IntPtr.Zero && input != new IntPtr(-1)) CloseHandle(input);
    }
  }

  public static int Main() {
    try {
      string payload = Environment.GetEnvironmentVariable("KAIROS_OWNED_SHELL_JOB");
      Environment.SetEnvironmentVariable("KAIROS_OWNED_SHELL_JOB", null);
      string[] fields = payload.Split('.');
      if (fields.Length != 5) throw new ArgumentException("Invalid shell supervision payload");
      for (int index = 0; index < fields.Length; index++) fields[index] = Encoding.UTF8.GetString(Convert.FromBase64String(fields[index]));
      return Run(fields[0], fields[1], fields[2], fields[3], UInt32.Parse(fields[4]));
    } catch (Exception error) {
      Console.Error.WriteLine("Windows shell supervision failed: " + error.GetBaseException().Message);
      return 125;
    }
  }
}
`;

const compileScript = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:KAIROS_JOB_SOURCE))
  Add-Type -TypeDefinition $source -OutputAssembly $env:KAIROS_JOB_EXECUTABLE -OutputType ConsoleApplication
} catch {
  [Console]::Error.WriteLine('Cannot build Windows shell supervisor: ' + $_.Exception.GetBaseException().Message)
  exit 1
}`;
let compiled: Promise<string> | undefined;
let executableBytes: Buffer | undefined;
let cachedFile: string | undefined;
let cachedDirectory: string | undefined;
let leases = 0;
let disposeRequested = false;
let deleting: Promise<void> = Promise.resolve();
let diagnostic: Promise<string> | undefined;
process.once('exit', () => {
  try { if (cachedFile) unlinkSync(cachedFile); if (cachedDirectory) rmdirSync(cachedDirectory); }
  catch { /* An abrupt exit may leave only this static helper artifact until temp cleanup. */ }
});

export function diagnoseWindowsShellJob(file: string): Promise<string> {
  return diagnostic ??= (async () => {
    const actual = readFileSync(file);
    const metadata = (data: Buffer | undefined) => data ? { size: data.length, mz: data.subarray(0, 2).toString('hex'), pe: data.length > 64 ? data.subarray(data.readUInt32LE(60), data.readUInt32LE(60) + 4).toString('hex') : '', sha256: createHash('sha256').update(data).digest('hex') } : null;
    const script = String.raw`[Environment]::SetEnvironmentVariable('KAIROS_OWNED_SHELL_JOB', $null, 'Process'); try { $info = New-Object Diagnostics.ProcessStartInfo; $info.FileName = $env:KAIROS_JOB_DIAGNOSTIC_FILE; $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true; $child = [Diagnostics.Process]::Start($info); if (-not $child.WaitForExit(5000)) { $child.Kill(); throw 'Diagnostic helper failed to exit' }; @{ NativeErrorCode = 0; ExitCode = $child.ExitCode } | ConvertTo-Json -Compress } catch { $error = $_.Exception; while ($error.InnerException) { $error = $error.InnerException }; @{ NativeErrorCode = $error.NativeErrorCode; Message = $error.Message } | ConvertTo-Json -Compress }`;
    const native = await new Promise<string>(resolve => {
      const probe = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, KAIROS_JOB_DIAGNOSTIC_FILE: file } });
      let output = '';
      const timer = setTimeout(() => { probe.kill(); resolve('Diagnostic timed out'); }, 8000);
      probe.stdout.setEncoding('utf8'); probe.stdout.on('data', (data: string) => { output += data.slice(0, Math.max(0, 4000 - output.length)); });
      probe.once('error', error => { clearTimeout(timer); resolve(error.message); });
      probe.once('close', () => { clearTimeout(timer); resolve(output.trim()); });
    });
    return JSON.stringify({ file, actual: metadata(actual), cached: metadata(executableBytes), native });
  })();
}

export function disposeWindowsShellJobs(): Promise<void> {
  disposeRequested = true;
  if (leases) return Promise.resolve();
  const file = cachedFile; const directory = cachedDirectory;
  cachedFile = undefined; cachedDirectory = undefined; compiled = undefined;
  deleting = deleting.then(async () => {
    if (file) await rm(file, { force: true }).catch(() => {});
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  });
  return deleting;
}

async function compileHelper(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-shell-job-'));
  const file = join(directory, 'supervisor.exe');
  try {
    if (executableBytes) await writeFile(file, executableBytes, { flag: 'wx' });
    else {
      await new Promise<void>((resolve, reject) => {
      const compiler = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(compileScript, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, KAIROS_JOB_SOURCE: Buffer.from(source, 'utf8').toString('base64'), KAIROS_JOB_EXECUTABLE: file } });
      let error = '';
      const timer = setTimeout(() => { compiler.kill(); reject(new Error('Windows shell supervisor compilation timed out')); }, 15000);
      compiler.stderr.setEncoding('utf8');
      compiler.stderr.on('data', (data: string) => { if (error.length < 15000) error += data.slice(0, 15000 - error.length); });
      compiler.once('error', reason => { clearTimeout(timer); reject(reason); });
      compiler.once('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(error.trim() || `Windows shell supervisor compilation failed (${code})`)); });
      });
      executableBytes = await readFile(file);
    }
    cachedFile = file; cachedDirectory = directory;
    return file;
  } catch (error) { await rm(file, { force: true }).catch(() => {}); await rm(directory, { recursive: true, force: true }).catch(() => {}); throw error; }
}

function quoted(value: string): string {
  return `"${value.replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`).replace(/(\\+)$/g, slashes => `${slashes}${slashes}`)}"`;
}

export async function windowsShellJob(invocation: ShellInvocation, cwd: string, env?: NodeJS.ProcessEnv): Promise<{ invocation: ShellInvocation; ready: string; release(): Promise<void> }> {
  const ready = `KAIROS_JOB_READY_${randomUUID()}`;
  const command = [invocation.file, ...invocation.args].map(quoted).join(' ');
  const payload = [isAbsolute(invocation.file) ? invocation.file : '', command, invocation.cwd ?? cwd, ready, String(process.pid)].map(value => Buffer.from(value, 'utf8').toString('base64')).join('.');
  if (command.length > 30000 || payload.length > 30000) throw new Error('Shell invocation exceeds the Windows job supervisor command/payload size limit');
  leases++;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true; leases--;
    if (!leases && disposeRequested) await disposeWindowsShellJobs();
  };
  let file: string;
  try {
    await deleting;
    disposeRequested = false;
    file = await (compiled ??= compileHelper().catch(error => { compiled = undefined; throw error; }));
  } catch (error) { await release(); throw error; }
  return { ready, release, invocation: {
    file, args: [],
    cwd: invocation.cwd ?? cwd, env: { ...(invocation.env ?? env ?? process.env), [payloadKey]: payload },
  } };
}
