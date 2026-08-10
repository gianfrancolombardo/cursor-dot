# Long-lived helper: compiles Win32 helpers once, then focuses by project name.
# Protocol: read one project line from stdin, write one result line to stdout.

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class CursorDotFocus {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  static readonly IntPtr HWND_TOP = new IntPtr(0);
  const uint SWP_NOSIZE = 0x0001;
  const uint SWP_NOMOVE = 0x0002;
  const uint SWP_SHOWWINDOW = 0x0040;

  public struct WinInfo {
    public IntPtr Hwnd;
    public string Title;
  }

  public static List<WinInfo> ListEditors() {
    var list = new List<WinInfo>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      var t = sb.ToString();
      if (string.IsNullOrWhiteSpace(t)) return true;
      if (t.Equals("Cursor Dot", StringComparison.OrdinalIgnoreCase)) return true;
      if (IsAgentsWindow(t)) return true;
      if (t.EndsWith(" - Cursor", StringComparison.OrdinalIgnoreCase) ||
          t.Equals("Cursor", StringComparison.OrdinalIgnoreCase)) {
        list.Add(new WinInfo { Hwnd = h, Title = t });
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static bool IsAgentsWindow(string title) {
    if (string.IsNullOrWhiteSpace(title)) return false;
    if (title.Equals("Cursor Agents", StringComparison.OrdinalIgnoreCase)) return true;
    if (title.Equals("Cursor Agent", StringComparison.OrdinalIgnoreCase)) return true;
    if (title.Equals("Agents", StringComparison.OrdinalIgnoreCase)) return true;
    return false;
  }

  public static List<WinInfo> ListAgents() {
    var list = new List<WinInfo>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      var t = sb.ToString();
      if (IsAgentsWindow(t)) {
        list.Add(new WinInfo { Hwnd = h, Title = t });
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static bool TitleMatchesProject(string title, string project) {
    if (string.IsNullOrWhiteSpace(title) || string.IsNullOrWhiteSpace(project)) return false;
    var p = project.Trim();
    if (title.Equals(p + " - Cursor", StringComparison.OrdinalIgnoreCase)) return true;
    if (title.EndsWith(" - " + p + " - Cursor", StringComparison.OrdinalIgnoreCase)) return true;
    var parts = title.Split(new[] { " - " }, StringSplitOptions.None);
    for (int i = 0; i < parts.Length - 1; i++) {
      if (parts[i].Equals(p, StringComparison.OrdinalIgnoreCase)) return true;
    }
    return false;
  }

  public static bool Focus(IntPtr found) {
    if (found == IntPtr.Zero) return false;
    // Only restore when minimized. SW_RESTORE also un-maximizes, which we must not do.
    if (IsIconic(found)) ShowWindow(found, 9);

    IntPtr fg = GetForegroundWindow();
    uint fgPid, targetPid;
    uint fgTid = GetWindowThreadProcessId(fg, out fgPid);
    uint targetTid = GetWindowThreadProcessId(found, out targetPid);
    uint curTid = GetCurrentThreadId();

    bool attachedFg = false;
    bool attachedTarget = false;
    if (fgTid != 0 && fgTid != curTid) {
      attachedFg = AttachThreadInput(curTid, fgTid, true);
    }
    if (targetTid != 0 && targetTid != curTid && targetTid != fgTid) {
      attachedTarget = AttachThreadInput(curTid, targetTid, true);
    }

    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetWindowPos(found, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    BringWindowToTop(found);
    SwitchToThisWindow(found, true);
    bool ok = SetForegroundWindow(found);

    if (attachedFg) AttachThreadInput(curTid, fgTid, false);
    if (attachedTarget) AttachThreadInput(curTid, targetTid, false);
    return ok;
  }
}
"@

function Focus-Project([string]$Project) {
  $project = ($Project | ForEach-Object { $_.Trim() })
  $preferAgentsOnly = -not $project -or $project -eq "unknown" -or $project -eq "workspace" -or $project -eq "__agents__"

  $chosen = $null

  if (-not $preferAgentsOnly) {
    $editors = [CursorDotFocus]::ListEditors()
    if ($editors -and $editors.Count -gt 0) {
      foreach ($w in $editors) {
        if ([CursorDotFocus]::TitleMatchesProject($w.Title, $project)) {
          $chosen = $w
          break
        }
      }
    }
  }

  # Agent Window / Cursor Agents: no project in title — use as fallback (or only target).
  if (-not $chosen) {
    $agents = [CursorDotFocus]::ListAgents()
    if ($agents -and $agents.Count -gt 0) {
      $chosen = $agents[0]
    }
  }

  if (-not $chosen) {
    if ($preferAgentsOnly) { return "no_project" }
    $editors = [CursorDotFocus]::ListEditors()
    if (-not $editors -or $editors.Count -eq 0) { return "none" }
    $names = ($editors | ForEach-Object { $_.Title }) -join "||"
    return "nomatch:$project;windows=$names"
  }

  [void][CursorDotFocus]::Focus($chosen.Hwnd)
  try {
    [void](New-Object -ComObject WScript.Shell).AppActivate($chosen.Title)
  } catch {}

  return "ok:$($chosen.Title)"
}

[Console]::Out.WriteLine("ready")
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq "" ) { continue }
  if ($line -eq "quit") { break }
  $result = Focus-Project $line
  [Console]::Out.WriteLine($result)
  [Console]::Out.Flush()
}
