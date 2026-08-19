// Vault-folder autocomplete for settings inputs.
//
// Any field that names a vault folder should use this rather than a hand-rolled
// dropdown — it's Obsidian's own suggest popover, so it matches core UI, keyboard
// nav, and theming for free.
import { AbstractInputSuggest, App, TAbstractFile, TFolder } from "obsidian";

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private onPick: (path: string) => void
  ) {
    super(app, inputEl);
  }

  protected getSuggestions(query: string): TFolder[] {
    const q = query.toLowerCase();
    const out: TFolder[] = [];
    // Vault root first so "put it at the top level" is one keystroke away.
    const root = this.app.vault.getRoot();
    if (root) out.push(root);
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (!isFolder(f) || f.isRoot?.()) continue;
      if (!q || f.path.toLowerCase().includes(q)) out.push(f as TFolder);
    }
    return out.slice(0, 50);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.isRoot?.() ? "/ (vault root)" : folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    const path = folder.isRoot?.() ? "/" : folder.path;
    this.setValue(path);
    this.onPick(path);
    this.close();
  }
}

function isFolder(f: TAbstractFile): f is TFolder {
  return (f as TFolder).children !== undefined;
}
