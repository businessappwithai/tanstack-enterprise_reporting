"use client";

import type { OnMount } from "@monaco-editor/react";
import { loader } from "@monaco-editor/react";
import { Loader2 } from "lucide-react";
import type { editor } from "monaco-editor";
import { useTheme } from "next-themes";
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";
import type { SchemaInfo } from "@/types/api";
import { getLogger } from "@/lib/logging/logger";

interface MonacoSQLEditorProps {
  value: string;
  onChange: (value: string) => void;
  onExecute?: () => void;
  readOnly?: boolean;
  height?: string | number;
  className?: string;
  schema?: SchemaInfo | null;
}

// Configure Monaco to use local package instead of CDN
loader.config({
  paths: {
    vs: "/vs",
  },
});

// Lazy load Monaco Editor
const MonacoSQLEditorComponent = lazy(() =>
  import("@monaco-editor/react").then((mod) => ({
    default: mod.default,
  }))
);

// Loading skeleton
function MonacoEditorSkeleton({ height }: { height?: string | number }) {
  return (
    <div
      className="flex items-center justify-center border rounded-md bg-muted"
      style={{ height: height || "400px" }}
    >
      <div className="flex flex-col items-center gap-2">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <span className="text-tremor-default text-tremor-content">Loading SQL Editor...</span>
      </div>
    </div>
  );
}

export function MonacoSQLEditorWrapper(props: MonacoSQLEditorProps) {
  const { theme } = useTheme();
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showPasteMenu, setShowPasteMenu] = useState(false);
  const [pastePosition, setPastePosition] = useState<{ x: number; y: number } | null>(null);

  const handleEditorMount: OnMount = useCallback(
    (editor: editor.IStandaloneCodeEditor, monaco) => {
      getLogger("sql").note("debug", "[INIT] MONACO EDITOR MOUNTING...");

      editorRef.current = editor;

      // Force editor to be fully editable
      editor.updateOptions({
        readOnly: false,
        domReadOnly: false,
        contextmenu: true,
      });

      // Set theme
      const monacoTheme = theme === "dark" ? "vs-dark" : "light";
      monaco.editor.setTheme(monacoTheme);

      // Add execute shortcut
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        getLogger("sql").note("debug", "[SHORTCUT] Execute triggered");
        props.onExecute?.();
      });

      // Add format shortcut
      editor.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => {
        getLogger("sql").note("debug", "[SHORTCUT] Format triggered");
        editor.getAction("editor.action.formatDocument")?.run();
      });

      // Monitor paste events from Monaco
      editor.onDidPaste((_event) => {
        getLogger("sql").note("debug", "✅✅✅ MONACO NATIVE PASTE SUCCESSFUL ✅✅✅");
        getLogger("sql").note("debug", "Current editor value:", { detail: [editor.getValue().substring(0, 100)] });
      });

      // Monitor all content changes
      editor.onDidChangeModelContent((e) => {
        if (e.changes.length > 0) {
          getLogger("sql").note("debug", "[CONTENT] Model content changed!");
        }
      });

      getLogger("sql").note("debug", "[INIT] ✅ Editor mounted successfully");
    },
    [props.onExecute, theme]
  );

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value !== undefined) {
        props.onChange(value);
      }
    },
    [props.onChange]
  );

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // MOUSE PASTE HANDLER - This handles paste via context menu or Edit menu
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const handlePasteViaClipboardAPI = useCallback(async () => {
    if (!editorRef.current) {
      getLogger("sql").note("error", "[MOUSE PASTE] No editor ref");
      return;
    }

    try {
      getLogger("sql").note("debug", "[MOUSE PASTE] Reading from clipboard API...");

      // Read clipboard content
      const clipboardText = await navigator.clipboard.readText();
      getLogger("sql").note("debug", "[MOUSE PASTE] Clipboard content:", { detail: [clipboardText.substring(0, 100)] });

      if (!clipboardText) {
        getLogger("sql").note("warn", "[MOUSE PASTE] Clipboard is empty");
        return;
      }

      // Get current selection and cursor position
      const selection = editorRef.current.getSelection();
      if (!selection) return;
      getLogger("sql").note("debug", "[MOUSE PASTE] Current selection:", { detail: [selection] });

      // Insert text at cursor position
      editorRef.current.executeEdits("paste", [
        {
          range: selection,
          text: clipboardText,
          forceMoveMarkers: true,
        },
      ]);

      getLogger("sql").note("debug", "[MOUSE PASTE] ✅ Successfully inserted text");
      getLogger("sql").note("debug", "[MOUSE PASTE] New value:", { detail: [editorRef.current.getValue().substring(0, 100)] });

      setShowPasteMenu(false);
    } catch (err) {
      getLogger("sql").note("error", "[MOUSE PASTE] ❌ Failed to paste:", { err: err });
      alert("Failed to paste. Please check browser permissions and try again.");
      setShowPasteMenu(false);
    }
  }, []);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // CONTEXT MENU HANDLER
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    getLogger("sql").note("debug", "[CONTEXT MENU] Right-click detected");

    // Prevent default context menu
    e.preventDefault();
    e.stopPropagation();

    // Get mouse position for context menu
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;

    getLogger("sql").note("debug", "[CONTEXT MENU] Position:", { detail: [{ x, y, rect }] });

    setPastePosition({ x, y });
    setShowPasteMenu(true);
  }, []);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GLOBAL MOUSE PASTE HANDLER - Catches paste from Edit menu
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const handleMousePaste = useCallback(async (e: React.ClipboardEvent<HTMLDivElement>) => {
    getLogger("sql").note("debug", "═══════════════════════════════════════════════════════════");
    getLogger("sql").note("debug", "[GLOBAL MOUSE PASTE] Paste event detected via mouse!");
    getLogger("sql").note("debug", "Event:", { detail: [{
      type: e.type,
      clipboardData: !!e.clipboardData,
      types: e.clipboardData?.types,
    }] });

    // Don't prevent default - let it propagate, but also handle it via clipboard API
    if (editorRef.current?.hasTextFocus()) {
      e.preventDefault();
      e.stopPropagation();

      try {
        const clipboardText = await navigator.clipboard.readText();
        getLogger("sql").note("debug", "[GLOBAL MOUSE PASTE] Clipboard content:", { detail: [clipboardText.substring(0, 100)] });

        if (clipboardText) {
          const selection = editorRef.current.getSelection();
          if (!selection) return;
          editorRef.current.executeEdits("paste", [
            {
              range: selection,
              text: clipboardText,
              forceMoveMarkers: true,
            },
          ]);
          getLogger("sql").note("debug", "[GLOBAL MOUSE PASTE] ✅ Text inserted");
        }
      } catch (err) {
        getLogger("sql").note("error", "[GLOBAL MOUSE PASTE] ❌ Failed:", { err: err });
      }
    }

    getLogger("sql").note("debug", "═══════════════════════════════════════════════════════════");
  }, []);

  const options = useMemo<editor.IStandaloneEditorConstructionOptions>(
    () => ({
      minimap: { enabled: false },
      fontSize: 14,
      lineNumbers: "on" as const,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      wordWrap: "on" as const,
      tabSize: 2,
      folding: false,
      renderLineHighlight: "all",
      dropHighlights: "inside",
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      fontLigatures: true,
      smoothScrolling: true,
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      formatOnPaste: true,
      formatOnType: true,
      readOnly: false,
      domReadOnly: false,
    }),
    []
  );

  // Focus editor when clicking container
  const handleClick = useCallback((_e: React.MouseEvent) => {
    if (editorRef.current) {
      editorRef.current.focus();
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className="monaco-editor-wrapper relative"
      role="button"
      tabIndex={0}
      onKeyDown={() => {}}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onPaste={handleMousePaste}
      style={{ cursor: "text" }}
    >
      <Suspense fallback={<MonacoEditorSkeleton height={props.height} />}>
        <MonacoSQLEditorComponent
          width="100%"
          height={props.height || "400px"}
          language="sql"
          onChange={handleChange}
          onMount={handleEditorMount}
          options={options}
          value={props.value}
          theme={theme === "dark" ? "vs-dark" : "light"}
          loading={<MonacoEditorSkeleton height={props.height} />}
        />
      </Suspense>

      {/* Custom Context Menu for Paste */}
      {showPasteMenu && pastePosition && (
        <div
          className="fixed bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-2 z-[99999]"
          style={{
            left: `${pastePosition.x}px`,
            top: `${pastePosition.y}px`,
            minWidth: "150px",
          }}
          onClick={(e) => {
            e.stopPropagation();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setShowPasteMenu(false);
          }}
          role="menu"
          tabIndex={0}
        >
          <button
            type="button"
            className="w-full text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
            onClick={(e) => {
              e.stopPropagation();
              handlePasteViaClipboardAPI();
            }}
          >
            <span>📋 Paste</span>
            <span className="text-xs text-gray-500">(Cmd+V)</span>
          </button>
          <button
            type="button"
            className="w-full text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
            onClick={(e) => {
              e.stopPropagation();
              setShowPasteMenu(false);
            }}
          >
            <span>Cancel</span>
          </button>
        </div>
      )}
    </div>
  );
}

// Re-export for backward compatibility
export { MonacoSQLEditor } from "./monaco-editor";
