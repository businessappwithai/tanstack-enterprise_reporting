"use client";

import Editor, { type OnChange, type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useTheme } from "next-themes";
import { memo, useCallback, useEffect, useRef } from "react";
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

function MonacoSQLEditorComponent({
  value,
  onChange,
  onExecute,
  readOnly: _readOnly, // Unused - editor is always editable
  height = "400px",
  className,
}: MonacoSQLEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const { theme } = useTheme();

  const handleEditorMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;

      // DEBUG: Log to verify this code runs
      getLogger("sql").note("debug", "[Monaco Editor] Mounting - forcing editable mode");

      // Force editor to be editable (ignore readOnly prop)
      editor.updateOptions({
        readOnly: false, // Always false, never readonly
        domReadOnly: false,
        contextmenu: true,
      });

      /*
       * The two readback logs that were here are gone, and with them the only
       * type error in this project.
       *
       * They read `readOnly` and `domReadOnly` straight back out of the editor
       * to confirm the `updateOptions` call above had taken — debugging left in,
       * printing "readOnly option: false" to the console of every reader who
       * ever opened the SQL editor.
       *
       * They also could not type-check, for a reason worth knowing before
       * reaching for `monaco.editor.EditorOption` again: `@monaco-editor/react`
       * types its two `OnMount` parameters from two different specifiers of the
       * same package —
       *
       *   import { editor } from "monaco-editor";                           // the editor
       *   import * as monaco from "monaco-editor/esm/vs/editor/editor.api";  // the namespace
       *
       * and the package's `exports` map sends those to two different files
       * (`editor.main.d.ts` and `editor.api.d.ts`). TypeScript enums are
       * nominal, so an `EditorOption` from the namespace is not the
       * `EditorOption` the editor's own methods accept, and any call mixing
       * them is TS2345 however obviously correct it looks.
       *
       * If you need to read an option back, take the value from the object you
       * passed to `updateOptions` rather than asking the editor for it.
       */

      // Add keyboard shortcut for execute (Ctrl/Cmd + Enter)
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        onExecute?.();
      });

      // Add keyboard shortcut for format (Shift + Alt + F)
      editor.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => {
        editor.getAction("editor.action.formatDocument")?.run();
      });
    },
    [onExecute]
  );

  const handleChange: OnChange = useCallback(
    (value) => {
      onChange(value || "");
    },
    [onChange]
  );

  // Force textarea to be editable and ensure pointer events work (monaco-editor workaround)
  useEffect(() => {
    const timer = setTimeout(() => {
      const monacoContainer = document.querySelector(".monaco-editor");
      const textarea = document.querySelector(".monaco-editor textarea");

      if (monacoContainer && textarea) {
        getLogger("sql").note("debug", "[Monaco Editor] Fixing z-index and input blocking...");

        // CRITICAL FIX: Bring textarea to front (z-index: -10 is wrong!)
        (textarea as HTMLTextAreaElement).style.zIndex = "1";
        getLogger("sql").note("debug", "[Monaco Editor] Set textarea z-index to 1");

        // Remove readonly
        (textarea as HTMLTextAreaElement).readOnly = false;
        (textarea as HTMLTextAreaElement).removeAttribute("readonly");
        getLogger("sql").note("debug", "[Monaco Editor] Removed readonly");

        // Remove aria-hidden
        textarea.removeAttribute("aria-hidden");
        getLogger("sql").note("debug", "[Monaco Editor] Removed aria-hidden");

        // Ensure pointer events are enabled
        const overflowGuard = monacoContainer.querySelector(".overflow-guard");
        if (overflowGuard) {
          (overflowGuard as HTMLElement).style.pointerEvents = "auto";
        }

        const viewLines = monacoContainer.querySelector(".view-lines");
        if (viewLines) {
          (viewLines as HTMLElement).style.pointerEvents = "auto";
        }

        // Focus the textarea
        (textarea as HTMLTextAreaElement).focus();
        getLogger("sql").note("debug", "[Monaco Editor] Focused textarea");
        getLogger("sql").note("debug", "[Monaco Editor] ✓ ALL FIXES APPLIED - TRY TYPING NOW!");
      }
    }, 300);

    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className={className}
      style={{
        height: typeof height === "number" ? `${height}px` : height,
        zIndex: 9999,
        pointerEvents: "auto",
        position: "relative",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Editor
        height={typeof height === "number" ? height : parseInt(height as string, 10)}
        language="sql"
        theme={theme === "dark" ? "vs-dark" : "light"}
        value={value}
        onChange={handleChange}
        onMount={handleEditorMount}
        options={{
          readOnly: false,
          domReadOnly: false,
          minimap: { enabled: false },
          lineNumbers: "on",
          folding: true,
          autoIndent: "full",
          formatOnPaste: true,
          formatOnType: true,
          suggestOnTriggerCharacters: true,
          quickSuggestions: {
            other: true,
            comments: false,
            strings: false,
          },
          wordBasedSuggestions: "off",
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          fontSize: 14,
          fontFamily: "JetBrains Mono, Menlo, Monaco, Consolas, monospace",
          renderWhitespace: "selection",
          bracketPairColorization: { enabled: true },
          guides: {
            bracketPairs: true,
            indentation: true,
          },
        }}
      />
    </div>
  );
}

// Memoize the component to prevent unnecessary re-renders
export const MonacoSQLEditor = memo(MonacoSQLEditorComponent, (prevProps, nextProps) => {
  return (
    prevProps.value === nextProps.value &&
    prevProps.onChange === nextProps.onChange &&
    prevProps.onExecute === nextProps.onExecute &&
    prevProps.readOnly === nextProps.readOnly &&
    prevProps.height === nextProps.height &&
    prevProps.className === nextProps.className
  );
});
