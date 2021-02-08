/********************************************************************************
 * Copyright (C) 2019 Red Hat, Inc. and others.
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

import * as theia from '@theia/plugin';
import { Emitter, Event } from '@theia/core/lib/common/event';
import {
    Plugin, PLUGIN_RPC_CONTEXT,
    ScmExt,
    ScmMain, ScmRawResource,
    ScmRawResourceSplice, ScmRawResourceSplices,
    SourceControlGroupFeatures
} from '../common';
import { Disposable, DisposableCollection } from '@theia/core/lib/common/disposable';
import { CommandRegistryImpl } from '../plugin/command-registry';
import { sortedDiff, Splice } from '../common/arrays';
import { UriComponents } from '../common/uri-components';
import { Command } from '../common/plugin-api-rpc-model';
import { RPCProtocol } from '../common/rpc-protocol';
import { comparePaths } from '../common/paths-util';
import { URI } from 'vscode-uri';
import { ScmCommandArg } from '../common/plugin-api-rpc';
type ProviderHandle = number;
type GroupHandle = number;
type ResourceStateHandle = number;

function getIconResource(decorations?: theia.SourceControlResourceThemableDecorations): theia.Uri | undefined {
    if (!decorations) {
        return undefined;
    } else if (typeof decorations.iconPath === 'string') {
        return URI.file(decorations.iconPath);
    } else {
        return decorations.iconPath;
    }
}

function compareResourceThemableDecorations(a: theia.SourceControlResourceThemableDecorations, b: theia.SourceControlResourceThemableDecorations): number {
    if (!a.iconPath && !b.iconPath) {
        return 0;
    } else if (!a.iconPath) {
        return -1;
    } else if (!b.iconPath) {
        return 1;
    }

    const aPath = typeof a.iconPath === 'string' ? a.iconPath : a.iconPath.fsPath;
    const bPath = typeof b.iconPath === 'string' ? b.iconPath : b.iconPath.fsPath;
    return comparePaths(aPath, bPath);
}

function compareResourceStatesDecorations(a: theia.SourceControlResourceDecorations, b: theia.SourceControlResourceDecorations): number {
    let result = 0;

    if (a.strikeThrough !== b.strikeThrough) {
        return a.strikeThrough ? 1 : -1;
    }

    if (a.faded !== b.faded) {
        return a.faded ? 1 : -1;
    }

    if (a.tooltip !== b.tooltip) {
        return (a.tooltip || '').localeCompare(b.tooltip || '');
    }

    result = compareResourceThemableDecorations(a, b);

    if (result !== 0) {
        return result;
    }

    if (a.light && b.light) {
        result = compareResourceThemableDecorations(a.light, b.light);
    } else if (a.light) {
        return 1;
    } else if (b.light) {
        return -1;
    }

    if (result !== 0) {
        return result;
    }

    if (a.dark && b.dark) {
        result = compareResourceThemableDecorations(a.dark, b.dark);
    } else if (a.dark) {
        return 1;
    } else if (b.dark) {
        return -1;
    }

    return result;
}

function compareCommands(a: theia.Command, b: theia.Command): number {
    if (a.command !== b.command) {
        return a.command! < b.command! ? -1 : 1;
    }

    if (a.title !== b.title) {
        return a.title! < b.title! ? -1 : 1;
    }

    if (a.tooltip !== b.tooltip) {
        if (a.tooltip !== undefined && b.tooltip !== undefined) {
            return a.tooltip < b.tooltip ? -1 : 1;
        } else if (a.tooltip !== undefined) {
            return 1;
        } else if (b.tooltip !== undefined) {
            return -1;
        }
    }

    if (a.arguments === b.arguments) {
        return 0;
    } else if (!a.arguments) {
        return -1;
    } else if (!b.arguments) {
        return 1;
    } else if (a.arguments.length !== b.arguments.length) {
        return a.arguments.length - b.arguments.length;
    }

    for (let i = 0; i < a.arguments.length; i++) {
        const aArg = a.arguments[i];
        const bArg = b.arguments[i];

        if (aArg === bArg) {
            continue;
        }

        return aArg < bArg ? -1 : 1;
    }

    return 0;
}

function compareResourceStates(a: theia.SourceControlResourceState, b: theia.SourceControlResourceState): number {
    let result = comparePaths(a.resourceUri.fsPath, b.resourceUri.fsPath, true);

    if (result !== 0) {
        return result;
    }

    if (a.command && b.command) {
        result = compareCommands(a.command, b.command);
    } else if (a.command) {
        return 1;
    } else if (b.command) {
        return -1;
    }

    if (result !== 0) {
        return result;
    }

    if (a.decorations && b.decorations) {
        result = compareResourceStatesDecorations(a.decorations, b.decorations);
    } else if (a.decorations) {
        return 1;
    } else if (b.decorations) {
        return -1;
    }

    return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compareArgs(a: any[], b: any[]): boolean {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }

    return true;
}

function commandEquals(a: theia.Command, b: theia.Command): boolean {
    return a.command === b.command
        && a.title === b.title
        && a.tooltip === b.tooltip
        && (a.arguments && b.arguments ? compareArgs(a.arguments, b.arguments) : a.arguments === b.arguments);
}

function commandListEquals(a: readonly theia.Command[], b: readonly theia.Command[]): boolean {
    return equals(a, b, commandEquals);
}

function equals<T>(one: ReadonlyArray<T> | undefined, other: ReadonlyArray<T> | undefined, itemEquals: (a: T, b: T) => boolean = (a, b) => a === b): boolean {
    if (one === other) {
        return true;
    }

    if (!one || !other) {
        return false;
    }

    if (one.length !== other.length) {
        return false;
    }

    for (let i = 0, len = one.length; i < len; i++) {
        if (!itemEquals(one[i], other[i])) {
            return false;
        }
    }

    return true;
}

export interface ValidateInput {
    (value: string, cursorPosition: number): theia.ProviderResult<theia.SourceControlInputBoxValidation | undefined | null>;
}

export class ScmInputBoxImpl implements theia.SourceControlInputBox {

    private _value: string = '';

    get value(): string {
        return this._value;
    }

    set value(value: string) {
        this._proxy.$setInputBoxValue(this._sourceControlHandle, value);
        this.updateValue(value);
    }

    private readonly _onDidChange = new Emitter<string>();

    get onDidChange(): Event<string> {
        return this._onDidChange.event;
    }

    private _placeholder: string = '';

    get placeholder(): string {
        return this._placeholder;
    }

    set placeholder(placeholder: string) {
        this._proxy.$setInputBoxPlaceholder(this._sourceControlHandle, placeholder);
        this._placeholder = placeholder;
    }

    private _validateInput: ValidateInput | undefined;

    get validateInput(): ValidateInput | undefined {
        // checkProposedApiEnabled(this._extension);

        return this._validateInput;
    }

    set validateInput(fn: ValidateInput | undefined) {
        // checkProposedApiEnabled(this._extension);

        if (fn && typeof fn !== 'function') {
            throw new Error(`[${this._extension.model.id}]: Invalid SCM input box validation function`);
        }

        this._validateInput = fn;
        // this._proxy.$setValidationProviderIsEnabled(this._sourceControlHandle, !!fn);
    }

    constructor(private _extension: Plugin, private _proxy: ScmMain, private _sourceControlHandle: number) {
        // noop
    }

    onInputBoxValueChange(value: string): void {
        this.updateValue(value);
    }

    private updateValue(value: string): void {
        this._value = value;
        this._onDidChange.fire(value);
    }
}

class ExtHostSourceControlResourceGroup implements theia.SourceControlResourceGroup {

    private static _handlePool: number = 0;
    private _resourceHandlePool: number = 0;
    private _resourceStates: theia.SourceControlResourceState[] = [];

    private _resourceStatesMap = new Map<ResourceStateHandle, theia.SourceControlResourceState>();
    private _resourceStatesCommandsMap = new Map<ResourceStateHandle, theia.Command>();
    private _resourceStatesDisposablesMap = new Map<ResourceStateHandle, Disposable>();

    private readonly _onDidUpdateResourceStates = new Emitter<void>();
    readonly onDidUpdateResourceStates = this._onDidUpdateResourceStates.event;

    private _disposed = false;
    get disposed(): boolean { return this._disposed; }
    private readonly _onDidDispose = new Emitter<void>();
    readonly onDidDispose = this._onDidDispose.event;

    private _handlesSnapshot: number[] = [];
    private _resourceSnapshot: theia.SourceControlResourceState[] = [];

    get id(): string { return this._id; }

    get label(): string { return this._label; }
    set label(label: string) {
        this._label = label;
        this._proxy.$updateGroupLabel(this._sourceControlHandle, this.handle, label);
    }

    private _hideWhenEmpty: boolean | undefined = undefined;
    get hideWhenEmpty(): boolean | undefined { return this._hideWhenEmpty; }
    set hideWhenEmpty(hideWhenEmpty: boolean | undefined) {
        this._hideWhenEmpty = hideWhenEmpty;
        this._proxy.$updateGroup(this._sourceControlHandle, this.handle, this.features);
    }

    get features(): SourceControlGroupFeatures {
        return {
            hideWhenEmpty: this.hideWhenEmpty
        };
    }

    get resourceStates(): theia.SourceControlResourceState[] { return [...this._resourceStates]; }
    set resourceStates(resources: theia.SourceControlResourceState[]) {
        this._resourceStates = [...resources];
        this._onDidUpdateResourceStates.fire();
    }

    readonly handle = ExtHostSourceControlResourceGroup._handlePool++;

    constructor(
        private _proxy: ScmMain,
        private _commands: CommandRegistryImpl,
        private _sourceControlHandle: number,
        private _id: string,
        private _label: string,
    ) { }

    getResourceState(handle: number): theia.SourceControlResourceState | undefined {
        return this._resourceStatesMap.get(handle);
    }

    $executeResourceCommand(handle: number, preserveFocus: boolean): Promise<void> {
        const command = this._resourceStatesCommandsMap.get(handle);

        if (!command) {
            return Promise.resolve(undefined);
        }

        return new Promise(() => this._commands.executeCommand(command.command!, ...(command.arguments || []), preserveFocus));
    }

    _takeResourceStateSnapshot(): ScmRawResourceSplice[] {
        const snapshot = [...this._resourceStates].sort(compareResourceStates);
        const diffs = sortedDiff(this._resourceSnapshot, snapshot, compareResourceStates);

        const splices = diffs.map<Splice<{ rawResource: ScmRawResource, handle: number }>>(diff => {
            const toInsert = diff.toInsert.map(r => {
                const handle = this._resourceHandlePool++;
                this._resourceStatesMap.set(handle, r);

                const sourceUri = r.resourceUri;
                const iconUri = getIconResource(r.decorations);
                const lightIconUri = r.decorations && getIconResource(r.decorations.light) || iconUri;
                const darkIconUri = r.decorations && getIconResource(r.decorations.dark) || iconUri;
                const icons: UriComponents[] = [];
                let command: Command | undefined;

                if (r.command) {
                    if (r.command.command === 'theia.open' || r.command.command === 'theia.diff') {
                        const disposables = new DisposableCollection();
                        command = this._commands.converter.toSafeCommand(r.command, disposables);
                        this._resourceStatesDisposablesMap.set(handle, disposables);
                    } else {
                        this._resourceStatesCommandsMap.set(handle, r.command);
                    }
                }

                if (lightIconUri) {
                    icons.push(lightIconUri);
                }

                if (darkIconUri && (darkIconUri.toString() !== lightIconUri?.toString())) {
                    icons.push(darkIconUri);
                }

                const tooltip = (r.decorations && r.decorations.tooltip) || '';
                const strikeThrough = r.decorations && !!r.decorations.strikeThrough;
                const faded = r.decorations && !!r.decorations.faded;
                const contextValue = r.contextValue || '';

                const rawResource = { handle, sourceUri, icons, tooltip, strikeThrough, faded, contextValue, command } as ScmRawResource;

                return { rawResource, handle };
            });

            return { start: diff.start, deleteCount: diff.deleteCount, toInsert };
        });

        const rawResourceSplices = splices
            .map(({ start, deleteCount, toInsert }) => ({
                    start: start,
                    deleteCount: deleteCount,
                    rawResources: toInsert.map(i => i.rawResource)
                } as ScmRawResourceSplice));

        const reverseSplices = splices.reverse();

        for (const { start, deleteCount, toInsert } of reverseSplices) {
            const handles = toInsert.map(i => i.handle);
            const handlesToDelete = this._handlesSnapshot.splice(start, deleteCount, ...handles);

            for (const handle of handlesToDelete) {
                this._resourceStatesMap.delete(handle);
                this._resourceStatesCommandsMap.delete(handle);
                this._resourceStatesDisposablesMap.get(handle)?.dispose();
                this._resourceStatesDisposablesMap.delete(handle);
            }
        }

        this._resourceSnapshot = snapshot;
        return rawResourceSplices;
    }

    dispose(): void {
        this._disposed = true;
        this._onDidDispose.fire();
    }
}

class ExtHostSourceControl implements theia.SourceControl {

    private static _handlePool: number = 0;
    private _groups: Map<GroupHandle, ExtHostSourceControlResourceGroup> = new Map<GroupHandle, ExtHostSourceControlResourceGroup>();

    get id(): string {
        return this._id;
    }

    get label(): string {
        return this._label;
    }

    get rootUri(): theia.Uri | undefined {
        return this._rootUri;
    }

    private _inputBox: ScmInputBoxImpl;
    get inputBox(): ScmInputBoxImpl { return this._inputBox; }

    private _count: number | undefined = undefined;

    get count(): number | undefined {
        return this._count;
    }

    set count(count: number | undefined) {
        if (this._count === count) {
            return;
        }

        this._count = count;
        this._proxy.$updateSourceControl(this.handle, { count });
    }

    private _quickDiffProvider: theia.QuickDiffProvider | undefined = undefined;

    get quickDiffProvider(): theia.QuickDiffProvider | undefined {
        return this._quickDiffProvider;
    }

    set quickDiffProvider(quickDiffProvider: theia.QuickDiffProvider | undefined) {
        this._quickDiffProvider = quickDiffProvider;
        this._proxy.$updateSourceControl(this.handle, { hasQuickDiffProvider: !!quickDiffProvider });
    }

    private _commitTemplate: string | undefined = undefined;

    get commitTemplate(): string | undefined {
        return this._commitTemplate;
    }

    set commitTemplate(commitTemplate: string | undefined) {
        if (commitTemplate === this._commitTemplate) {
            return;
        }

        this._commitTemplate = commitTemplate;
        this._proxy.$updateSourceControl(this.handle, { commitTemplate });
    }

    private _acceptInputDisposables = new DisposableCollection();
    private _acceptInputCommand: theia.Command | undefined = undefined;

    get acceptInputCommand(): theia.Command | undefined {
        return this._acceptInputCommand;
    }

    set acceptInputCommand(acceptInputCommand: theia.Command | undefined) {
        this._acceptInputDisposables = new DisposableCollection();

        this._acceptInputCommand = acceptInputCommand;

        const internal = this._commands.converter.toSafeCommand(acceptInputCommand, this._acceptInputDisposables);
        this._proxy.$updateSourceControl(this.handle, { acceptInputCommand: internal });
    }

    private _statusBarDisposables = new DisposableCollection();
    private _statusBarCommands: theia.Command[] | undefined = undefined;

    get statusBarCommands(): theia.Command[] | undefined {
        return this._statusBarCommands;
    }

    set statusBarCommands(statusBarCommands: theia.Command[] | undefined) {
        if (this._statusBarCommands && statusBarCommands && commandListEquals(this._statusBarCommands, statusBarCommands)) {
            return;
        }

        this._statusBarDisposables = new DisposableCollection();

        this._statusBarCommands = statusBarCommands;

        const internal = (statusBarCommands || []).map(c => this._commands.converter.toSafeCommand(c, this._statusBarDisposables)) as Command[];
        this._proxy.$updateSourceControl(this.handle, { statusBarCommands: internal });
    }

    private _selected: boolean = false;

    get selected(): boolean {
        return this._selected;
    }

    private readonly _onDidChangeSelection = new Emitter<boolean>();
    readonly onDidChangeSelection = this._onDidChangeSelection.event;

    private handle: number = ExtHostSourceControl._handlePool++;

    constructor(
        _extension: Plugin,
        private _proxy: ScmMain,
        private _commands: CommandRegistryImpl,
        private _id: string,
        private _label: string,
        private _rootUri?: theia.Uri
    ) {
        this._inputBox = new ScmInputBoxImpl(_extension, this._proxy, this.handle);
        this._proxy.$registerSourceControl(this.handle, _id, _label, _rootUri);
    }

    private createdResourceGroups = new Map<ExtHostSourceControlResourceGroup, Disposable>();
    private updatedResourceGroups = new Set<ExtHostSourceControlResourceGroup>();

    createResourceGroup(id: string, label: string): ExtHostSourceControlResourceGroup {
        const group = new ExtHostSourceControlResourceGroup(this._proxy, this._commands, this.handle, id, label);
        const disposable = group.onDidDispose(() => this.createdResourceGroups.delete(group));
        this.createdResourceGroups.set(group, disposable);
        this.eventuallyAddResourceGroups();
        return group;
    }

    // @debounce(100)
    eventuallyAddResourceGroups(): void {
        const groups: [number /* handle*/, string /* id*/, string /* label*/, SourceControlGroupFeatures][] = [];
        const splices: ScmRawResourceSplices[] = [];

        for (const [group, disposable] of this.createdResourceGroups) {
            disposable.dispose();

            const updateListener = group.onDidUpdateResourceStates(() => {
                this.updatedResourceGroups.add(group);
                this.eventuallyUpdateResourceStates();
            });

            group.onDidDispose(() => {
                this.updatedResourceGroups.delete(group);
                updateListener.dispose();
                this._groups.delete(group.handle);
                this._proxy.$unregisterGroup(this.handle, group.handle);
            });

            groups.push([group.handle, group.id, group.label, group.features]);

            const snapshot = group._takeResourceStateSnapshot();

            if (snapshot.length > 0) {
                splices.push( { handle: group.handle, splices: snapshot });
            }

            this._groups.set(group.handle, group);
        }

        this._proxy.$registerGroups(this.handle, groups, splices);
        this.createdResourceGroups.clear();
    }

    // @debounce(100)
    eventuallyUpdateResourceStates(): void {
        const splices: ScmRawResourceSplices[] = [];

        this.updatedResourceGroups.forEach(group => {
            const snapshot = group._takeResourceStateSnapshot();

            if (snapshot.length === 0) {
                return;
            }

            splices.push({ handle: group.handle, splices: snapshot });
        });

        if (splices.length > 0) {
            this._proxy.$spliceResourceStates(this.handle, splices);
        }

        this.updatedResourceGroups.clear();
    }

    getResourceGroup(handle: GroupHandle): ExtHostSourceControlResourceGroup | undefined {
        return this._groups.get(handle);
    }

    setSelectionState(selected: boolean): void {
        this._selected = selected;
        this._onDidChangeSelection.fire(selected);
    }

    dispose(): void {
        this._acceptInputDisposables.dispose();
        this._statusBarDisposables.dispose();

        this._groups.forEach(group => group.dispose());
        this._proxy.$unregisterSourceControl(this.handle);
    }
}

export class ScmExtImpl implements ScmExt {

    private static _handlePool: number = 0;

    private _proxy: ScmMain;
    // private readonly _telemetry: MainThreadTelemetryShape;
    private _sourceControls: Map<ProviderHandle, ExtHostSourceControl> = new Map<ProviderHandle, ExtHostSourceControl>();
    private _sourceControlsByExtension: Map<string, ExtHostSourceControl[]> = new Map<string, ExtHostSourceControl[]>();

    private readonly _onDidChangeActiveProvider = new Emitter<theia.SourceControl>();
    get onDidChangeActiveProvider(): Event<theia.SourceControl> { return this._onDidChangeActiveProvider.event; }

    private _selectedSourceControlHandle: number | undefined;

    constructor(
        rpc: RPCProtocol,
        private _commands: CommandRegistryImpl,
        // @ILogService private readonly logService: ILogService
    ) {
        this._proxy = rpc.getProxy(PLUGIN_RPC_CONTEXT.SCM_MAIN);
        // this._telemetry = mainContext.getProxy(MainContext.MainThreadTelemetry);

        _commands.registerArgumentProcessor({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            processArgument: (arg: any) => {
                if (!ScmCommandArg.is(arg)) {
                    return arg;
                }
                const sourceControl = this._sourceControls.get(arg.sourceControlHandle);
                if (!sourceControl) {
                    return undefined;
                }
                if (typeof arg.resourceGroupHandle !== 'number') {
                    return sourceControl;
                }
                const resourceGroup = sourceControl.getResourceGroup(arg.resourceGroupHandle);
                if (typeof arg.resourceStateHandle !== 'number') {
                    return resourceGroup;
                }
                return resourceGroup && resourceGroup.getResourceState(arg.resourceStateHandle);
            }
        });
    }

    createSourceControl(extension: Plugin, id: string, label: string, rootUri: theia.Uri | undefined): theia.SourceControl {
        // this.logService.trace('ExtHostSCM#createSourceControl', extension.identifier.value, id, label, rootUri);

        // type TEvent = { extensionId: string; };
        // type TMeta = { extensionId: { classification: 'SystemMetaData', purpose: 'FeatureInsight' }; };
        // this._telemetry.$publicLog2<TEvent, TMeta>('api/scm/createSourceControl', {
        //     extensionId: extension.identifier.value,
        // });

        const handle = ScmExtImpl._handlePool++;
        const sourceControl = new ExtHostSourceControl(extension, this._proxy, this._commands, id, label, rootUri);
        this._sourceControls.set(handle, sourceControl);

        const sourceControls = this._sourceControlsByExtension.get(extension.model.id) || [];
        sourceControls.push(sourceControl);
        this._sourceControlsByExtension.set(extension.model.id, sourceControls);

        return sourceControl;
    }

    // Deprecated
    getLastInputBox(extension: Plugin): ScmInputBoxImpl | undefined {
        // this.logService.trace('ExtHostSCM#getLastInputBox', extension.identifier.value);

        const sourceControls = this._sourceControlsByExtension.get(extension.model.id);
        const sourceControl = sourceControls && sourceControls[sourceControls.length - 1];
        return sourceControl && sourceControl.inputBox;
    }

    $provideOriginalResource(sourceControlHandle: number, uriComponents: string, token: theia.CancellationToken): Promise<UriComponents | undefined> {
        // const uri = URI.revive(uriComponents);
        // this.logService.trace('ExtHostSCM#$provideOriginalResource', sourceControlHandle, uri.toString());

        const sourceControl = this._sourceControls.get(sourceControlHandle);

        if (!sourceControl || !sourceControl.quickDiffProvider || !sourceControl.quickDiffProvider.provideOriginalResource) {
            return Promise.resolve(undefined);
        }

        return new Promise<UriComponents | undefined>(() => sourceControl.quickDiffProvider!.provideOriginalResource!(URI.file(uriComponents), token))
            .then<UriComponents | undefined>(r => r || undefined);
    }

    $onInputBoxValueChange(sourceControlHandle: number, value: string): Promise<void> {
        // this.logService.trace('ExtHostSCM#$onInputBoxValueChange', sourceControlHandle);

        const sourceControl = this._sourceControls.get(sourceControlHandle);

        if (!sourceControl) {
            return Promise.resolve(undefined);
        }

        sourceControl.inputBox.onInputBoxValueChange(value);
        return Promise.resolve(undefined);
    }

    $executeResourceCommand(sourceControlHandle: number, groupHandle: number, handle: number, preserveFocus: boolean): Promise<void> {
        // this.logService.trace('ExtHostSCM#$executeResourceCommand', sourceControlHandle, groupHandle, handle);

        const sourceControl = this._sourceControls.get(sourceControlHandle);

        if (!sourceControl) {
            return Promise.resolve(undefined);
        }

        const group = sourceControl.getResourceGroup(groupHandle);

        if (!group) {
            return Promise.resolve(undefined);
        }

        return group.$executeResourceCommand(handle, preserveFocus);
    }

    async $validateInput(sourceControlHandle: number, value: string, cursorPosition: number): Promise<[string, number] | undefined> {
        // this.logService.trace('ExtHostSCM#$validateInput', sourceControlHandle);

        const sourceControl = this._sourceControls.get(sourceControlHandle);

        if (!sourceControl) {
            return Promise.resolve(undefined);
        }

        if (!sourceControl.inputBox.validateInput) {
            return Promise.resolve(undefined);
        }

        const result = await sourceControl.inputBox.validateInput!(value, cursorPosition);
        if (!result) {
            return Promise.resolve(undefined);
        }
        return [result.message, result.type];
    }

    $setSelectedSourceControl(selectedSourceControlHandle: number | undefined): Promise<void> {
        // this.logService.trace('ExtHostSCM#$setSelectedSourceControl', selectedSourceControlHandle);

        if (selectedSourceControlHandle !== undefined) {
            this._sourceControls.get(selectedSourceControlHandle)?.setSelectionState(true);
        }

        if (this._selectedSourceControlHandle !== undefined) {
            this._sourceControls.get(this._selectedSourceControlHandle)?.setSelectionState(false);
        }

        this._selectedSourceControlHandle = selectedSourceControlHandle;
        return Promise.resolve(undefined);
    }
}
