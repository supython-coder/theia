/********************************************************************************
 * Copyright (C) 2017 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { inject, injectable } from 'inversify';
import {
    QuickOpenModel, QuickOpenItem, QuickOpenMode, PrefixQuickOpenService,
    OpenerService, KeybindingRegistry, QuickOpenGroupItem, QuickOpenGroupItemOptions, QuickOpenItemOptions,
    QuickOpenHandler, QuickOpenOptions
} from '@theia/core/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import URI from '@theia/core/lib/common/uri';
import { FileSearchService } from '../common/file-search-service';
import { CancellationTokenSource } from '@theia/core/lib/common';
import { LabelProvider } from '@theia/core/lib/browser/label-provider';
import { Command } from '@theia/core/lib/common';
import { NavigationLocationService } from '@theia/editor/lib/browser/navigation/navigation-location-service';
import * as fuzzy from 'fuzzy';
import { MessageService } from '@theia/core/lib/common/message-service';
import { FileSystemPreferences } from '@theia/filesystem/lib/browser';

export const quickFileOpen: Command = {
    id: 'file-search.openFile',
    category: 'File',
    label: 'Open File...'
};

@injectable()
export class QuickFileOpenService implements QuickOpenModel, QuickOpenHandler {

    @inject(KeybindingRegistry)
    protected readonly keybindingRegistry: KeybindingRegistry;
    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;
    @inject(OpenerService)
    protected readonly openerService: OpenerService;
    @inject(PrefixQuickOpenService)
    protected readonly quickOpenService: PrefixQuickOpenService;
    @inject(FileSearchService)
    protected readonly fileSearchService: FileSearchService;
    @inject(LabelProvider)
    protected readonly labelProvider: LabelProvider;
    @inject(NavigationLocationService)
    protected readonly navigationLocationService: NavigationLocationService;
    @inject(MessageService)
    protected readonly messageService: MessageService;
    @inject(FileSystemPreferences)
    protected readonly fsPreferences: FileSystemPreferences;

    /**
     * Whether to hide .gitignored (and other ignored) files.
     */
    protected hideIgnoredFiles: boolean = true;

    /**
     * Whether the dialog is currently open.
     */
    protected isOpen: boolean = false;

    /**
     * The current lookFor string input by the user.
     */
    protected currentLookFor: string = '';

    readonly prefix: string = '...';

    get description(): string {
        return 'Open File';
    }

    getModel(): QuickOpenModel {
        return this;
    }

    getOptions(): QuickOpenOptions {
        let placeholder = 'File name to search.';
        const keybinding = this.getKeyCommand();
        if (keybinding) {
            placeholder += ` (Press ${keybinding} to show/hide ignored files)`;
        }
        return {
            placeholder,
            fuzzyMatchLabel: {
                enableSeparateSubstringMatching: true
            },
            fuzzyMatchDescription: {
                enableSeparateSubstringMatching: true
            },
            showItemsWithoutHighlight: true,
            onClose: () => {
                this.isOpen = false;
                this.cancelIndicator.cancel();
            }
        };
    }

    isEnabled(): boolean {
        return this.workspaceService.opened;
    }

    open(): void {
        // Triggering the keyboard shortcut while the dialog is open toggles
        // showing the ignored files.
        if (this.isOpen) {
            this.hideIgnoredFiles = !this.hideIgnoredFiles;
        } else {
            this.hideIgnoredFiles = true;
            this.currentLookFor = '';
            this.isOpen = true;
        }

        this.quickOpenService.open(this.currentLookFor);
    }

    /**
     * Get a string (suitable to show to the user) representing the keyboard
     * shortcut used to open the quick file open menu.
     */
    protected getKeyCommand(): string | undefined {
        const keyCommand = this.keybindingRegistry.getKeybindingsForCommand(quickFileOpen.id);
        if (keyCommand) {
            // We only consider the first keybinding.
            const accel = this.keybindingRegistry.acceleratorFor(keyCommand[0], '+');
            return accel.join(' ');
        }

        return undefined;
    }

    private cancelIndicator = new CancellationTokenSource();

    public async onType(lookFor: string, acceptor: (items: QuickOpenItem[]) => void): Promise<void> {
        this.cancelIndicator.cancel();
        this.cancelIndicator = new CancellationTokenSource();
        const token = this.cancelIndicator.token;

        const roots = this.workspaceService.tryGetRoots();

        this.currentLookFor = lookFor;
        const alreadyCollected = new Set<string>();
        const recentlyUsedItems: QuickOpenItem[] = [];

        const locations = [...this.navigationLocationService.locations()].reverse();
        for (const location of locations) {
            const uriString = location.uri.toString();
            if (location.uri.scheme === 'file' && !alreadyCollected.has(uriString) && fuzzy.test(lookFor, uriString)) {
                const item = this.toItem(location.uri, { groupLabel: recentlyUsedItems.length === 0 ? 'recently opened' : undefined, showBorder: false });
                recentlyUsedItems.push(item);
                alreadyCollected.add(uriString);
            }
        }
        if (lookFor.length > 0) {
            const handler = async (results: string[]) => {
                if (token.isCancellationRequested) {
                    return;
                }
                const fileSearchResultItems: QuickOpenItem[] = [];

                if (results.length <= 0) {
                    acceptor([this.toNoResultsItem()]);
                    return;
                }

                for (const fileUri of results) {
                    if (!alreadyCollected.has(fileUri)) {
                        const item = this.toItem(fileUri);
                        fileSearchResultItems.push(item);
                        alreadyCollected.add(fileUri);
                    }
                }

                // Extract the first element, and re-add it to the array with the group label.
                const first = fileSearchResultItems[0];
                fileSearchResultItems.shift();
                if (first) {
                    const item = this.toItem(first.getUri()!, { groupLabel: 'file results', showBorder: !!recentlyUsedItems.length });
                    fileSearchResultItems.unshift(item);
                }
                // Return the recently used items, followed by the search results.
                acceptor([...recentlyUsedItems, ...fileSearchResultItems]);
            };

            this.fileSearchService.find(lookFor, {
                rootUris: roots.map(r => r.resource.toString()),
                fuzzyMatch: true,
                limit: 200,
                useGitIgnore: this.hideIgnoredFiles,
                excludePatterns: this.hideIgnoredFiles
                    ? Object.keys(this.fsPreferences['files.exclude'])
                    : undefined,
            }, token).then(handler);
        } else {
            if (roots.length !== 0) {
                acceptor(recentlyUsedItems);
            }
        }
    }

    protected getRunFunction(uri: URI): (mode: QuickOpenMode) => boolean {
        return (mode: QuickOpenMode) => {
            if (mode !== QuickOpenMode.OPEN) {
                return false;
            }
            this.openFile(uri);
            return true;
        };
    }

    openFile(uri: URI): void {
        this.openerService.getOpener(uri)
            .then(opener => opener.open(uri))
            .catch(error => this.messageService.error(error));
    }

    private toItem(uriOrString: URI | string, group?: QuickOpenGroupItemOptions): QuickOpenItem<QuickOpenItemOptions> {
        const uri = uriOrString instanceof URI ? uriOrString : new URI(uriOrString);
        let description = this.labelProvider.getLongName(uri.parent);
        if (this.workspaceService.isMultiRootWorkspaceOpened) {
            const rootUri = this.workspaceService.getWorkspaceRootUri(uri);
            if (rootUri) {
                description = `${rootUri.displayName} • ${description}`;
            }
        }
        const icon = this.labelProvider.getIcon(uri);
        const iconClass = icon === '' ? undefined : icon + ' file-icon';
        const options: QuickOpenItemOptions = {
            label: this.labelProvider.getName(uri),
            iconClass,
            description,
            tooltip: this.labelProvider.getLongName(uri),
            uri: uri,
            hidden: false,
            run: this.getRunFunction(uri)
        };
        if (group) {
            return new QuickOpenGroupItem<QuickOpenGroupItemOptions>({ ...options, ...group });
        } else {
            return new QuickOpenItem<QuickOpenItemOptions>(options);
        }
    }

    private toNoResultsItem(): QuickOpenItem<QuickOpenItemOptions> {
        const options: QuickOpenItemOptions = {
            label: 'No matching results',
            run: () => false
        };
        return new QuickOpenItem<QuickOpenItemOptions>(options);
    }
}
