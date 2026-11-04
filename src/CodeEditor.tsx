import { useRef } from 'react';
import { loader, Editor, DiffEditor } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
(self as any).MonacoEnvironment = { getWorker(_: unknown, label: string) { if (label === 'json') return new JsonWorker(); if (['css', 'scss', 'less'].includes(label)) return new CssWorker(); if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker(); if (['typescript', 'javascript'].includes(label)) return new TsWorker(); return new EditorWorker(); } };
loader.config({ monaco });
const languages: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', json: 'json', py: 'python', md: 'markdown', css: 'css', html: 'html', go: 'go', rs: 'rust', sh: 'shell', ps1: 'powershell', yaml: 'yaml', yml: 'yaml', toml: 'ini', sql: 'sql', xml: 'xml', c: 'c', cpp: 'cpp', h: 'cpp', java: 'java', cs: 'csharp' };
const language = (path: string) => languages[path.split('.').pop() || ''] || 'plaintext';
export default function CodeEditor({ path, value, onChange, dark, onSave, uiScale = 110 }: { path: string; value: string; onChange(value: string): void; dark: boolean; onSave(): void; uiScale?: number }) {
  const saveRef = useRef(onSave); saveRef.current = onSave;
  return <Editor path={path} language={language(path)} value={value} theme={dark ? 'vs-dark' : 'vs'} onChange={value => onChange(value || '')} onMount={editor => { editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current()); }} options={{ fontSize: Math.round(14 * uiScale / 100), fontFamily: 'Consolas, monospace', minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 16 }, wordWrap: 'on', tabSize: 2, renderLineHighlight: 'gutter' }} loading={<div className="panel-empty">Loading editor…</div>} />;
}
export function CodeDiff({ path, original, modified, dark }: { path: string; original: string; modified: string; dark: boolean }) { return <DiffEditor language={language(path)} original={original} modified={modified} theme={dark ? 'vs-dark' : 'vs'} options={{ readOnly: true, minimap: { enabled: false }, automaticLayout: true, fontSize: 14, renderSideBySide: false, scrollBeyondLastLine: false, wordWrap: 'on' }} />; }
