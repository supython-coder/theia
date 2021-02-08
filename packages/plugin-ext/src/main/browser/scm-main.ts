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

import {
    MAIN_RPC_CONTEXT,
    ScmExt,
    SourceControlGroupFeatures,
    ScmMain,
    SourceControlProviderFeatures,
    SCMRawResourceSplices
} from '../../common/plugin-api-rpc';
import { ScmProvider, ScmResource, ScmResourceDecorations, ScmResourceGroup, ScmCommand } from '@theia/scm/lib/browser/scm-provider';
import { ScmRepository } from '@theia/scm/lib/browser/scm-repository';
import { ScmService } from '@theia/scm/lib/browser/scm-service';
import { RPCProtocol } from '../../common/rpc-protocol';
import { interfaces } from 'inversify';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import URI from '@theia/core/lib/common/uri';
import { URI as vscodeURI } from 'vscode-uri';
import { Splice } from '../../common/arrays';
import { UriComponents } from '../../common/uri-components';

export class PluginScmResourceGroup implements ScmResourceGroup {

    readonly resources: ScmResource[] = [];

    private readonly _onDidSplice = new Emitter<Splice<ScmResource>>();
    readonly onDidSplice = this._onDidSplice.event;

    get hideWhenEmpty(): boolean { return !!this.features.hideWhenEmpty; }

    private readonly _onDidChange = new Emitter<void>();
    readonly onDidChange: Event<void> = this._onDidChange.event;

    constructor(
        private readonly sourceControlHandle: number,
        readonly handle: number,
        public provider: PluginScmProvider,
        public features: SourceControlGroupFeatures,
        public label: string,
        public id: string
    ) { }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toJSON(): any {
        return {
            $mid: 4,
            sourceControlHandle: this.sourceControlHandle,
            groupHandle: this.handle
        };
    }

    splice(start: number, deleteCount: number, toInsert: ScmResource[]): void {
        this.resources.splice(start, deleteCount, ...toInsert);
        this._onDidSplice.fire({ start, deleteCount, toInsert });
    }

    $updateGroup(features: SourceControlGroupFeatures): void {
        this.features = { ...this.features, ...features };
        this._onDidChange.fire();
    }

    $updateGroupLabel(label: string): void {
        this.label = label;
        this._onDidChange.fire();
    }

    dispose(): void { }
}

export class PluginScmResource implements ScmResource {

    constructor(
        private readonly proxy: ScmExt,
        private readonly sourceControlHandle: number,
        private readonly groupHandle: number,
        readonly handle: number,
        readonly sourceUri: URI,
        readonly group: PluginScmResourceGroup,
        readonly decorations: ScmResourceDecorations,
        readonly contextValue: string | undefined,
        readonly command: ScmCommand | undefined
    ) { }

    open(preserveFocus: boolean): Promise<void> {
        return this.proxy.$executeResourceCommand(this.sourceControlHandle, this.groupHandle, this.handle, preserveFocus);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toJSON(): any {
        return {
            $mid: 3,
            sourceControlHandle: this.sourceControlHandle,
            groupHandle: this.groupHandle,
            handle: this.handle
        };
    }
}

export class PluginScmProvider implements ScmProvider {

    // private static ID_HANDLE = 0;
    private _id = this.contextValue;
    get id(): string { return this._id; }

    readonly groups: PluginScmResourceGroup[] = [];
    private readonly _groupsByHandle: { [handle: number]: PluginScmResourceGroup; } = Object.create(null);

    // get groups(): ISequence<ISCMResourceGroup> {
    //     return {
    //         elements: this._groups,
    //         onDidSplice: this._onDidSplice.event
    //     };
    //
    //     // return this._groups
    //     // .filter(g => g.resources.elements.length > 0 || !g.features.hideWhenEmpty);
    // }

    private readonly _onDidChangeResources = new Emitter<void>();
    readonly onDidChangeResources: Event<void> = this._onDidChangeResources.event;

    private features: SourceControlProviderFeatures = {};

    get handle(): number { return this._handle; }
    get label(): string { return this._label; }
    get rootUri(): string { return this._rootUri ? this._rootUri.toString() : ''; }
    get contextValue(): string { return this._contextValue; }

    get commitTemplate(): string { return this.features.commitTemplate || ''; }
    get acceptInputCommand(): ScmCommand | undefined { return this.features.acceptInputCommand; }
    get statusBarCommands(): ScmCommand[] | undefined { return this.features.statusBarCommands; }
    get count(): number | undefined { return this.features.count; }

    private readonly _onDidChangeCommitTemplate = new Emitter<string>();
    readonly onDidChangeCommitTemplate: Event<string> = this._onDidChangeCommitTemplate.event;

    private readonly _onDidChangeStatusBarCommands = new Emitter<ScmCommand[]>();
    get onDidChangeStatusBarCommands(): Event<ScmCommand[]> { return this._onDidChangeStatusBarCommands.event; }

    private readonly _onDidChange = new Emitter<void>();
    readonly onDidChange: Event<void> = this._onDidChange.event;

    constructor(
        private readonly proxy: ScmExt,
        private readonly _handle: number,
        private readonly _contextValue: string,
        private readonly _label: string,
        private readonly _rootUri: vscodeURI | undefined
    ) { }

    $updateSourceControl(features: SourceControlProviderFeatures): void {
        this.features = { ...this.features, ...features };
        this._onDidChange.fire();

        if (typeof features.commitTemplate !== 'undefined') {
            this._onDidChangeCommitTemplate.fire(this.commitTemplate!);
        }

        if (typeof features.statusBarCommands !== 'undefined') {
            this._onDidChangeStatusBarCommands.fire(this.statusBarCommands!);
        }
    }

    $registerGroups(_groups: [number /* handle*/, string /* id*/, string /* label*/, SourceControlGroupFeatures][]): void {
        const groups = _groups.map(([handle, id, label, features]) => {
            const group = new PluginScmResourceGroup(
                this.handle,
                handle,
                this,
                features,
                label,
                id
            );

            this._groupsByHandle[handle] = group;
            return group;
        });

        this.groups.splice(this.groups.length, 0, ...groups);
    }

    $updateGroup(handle: number, features: SourceControlGroupFeatures): void {
        const group = this._groupsByHandle[handle];

        if (!group) {
            return;
        }

        group.$updateGroup(features);
    }

    $updateGroupLabel(handle: number, label: string): void {
        const group = this._groupsByHandle[handle];

        if (!group) {
            return;
        }

        group.$updateGroupLabel(label);
    }

    $spliceGroupResourceStates(splices: SCMRawResourceSplices[]): void {
        for (const [groupHandle, groupSlices] of splices) {
            const group = this._groupsByHandle[groupHandle];

            if (!group) {
                console.warn(`SCM group ${groupHandle} not found in provider ${this.label}`);
                continue;
            }

            // reverse the splices sequence in order to apply them correctly
            groupSlices.reverse();

            for (const [start, deleteCount, rawResources] of groupSlices) {
                const resources = rawResources.map(rawResource => {
                    const [handle, sourceUri, icons, tooltip, strikeThrough, faded, contextValue, command] = rawResource;
                    const icon = icons[0];
                    const iconDark = icons[1] || icon;
                    const decorations = {
                        icon: icon ? vscodeURI.revive(icon) : undefined,
                        iconDark: iconDark ? vscodeURI.revive(iconDark) : undefined,
                        tooltip,
                        strikeThrough,
                        faded
                    };

                    return new PluginScmResource(
                        this.proxy,
                        this.handle,
                        groupHandle,
                        handle,
                        new URI(vscodeURI.revive(sourceUri)),
                        group,
                        decorations,
                        contextValue || undefined,
                        command
                    );
                });

                group.splice(start, deleteCount, resources);
            }
        }

        this._onDidChangeResources.fire();
    }

    $unregisterGroup(handle: number): void {
        const group = this._groupsByHandle[handle];

        if (!group) {
            return;
        }

        delete this._groupsByHandle[handle];
        this.groups.splice(this.groups.indexOf(group), 1);
    }

    // async getOriginalResource(uri: URI): Promise<URI | null> {
    //     if (!this.features.hasQuickDiffProvider) {
    //         return null;
    //     }
    //
    //     const result = await this.proxy.$provideOriginalResource(this.handle, uri, CancellationToken.None);
    //     return result && URI.revive(result);
    // }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toJSON(): any {
        return {
            $mid: 5,
            handle: this.handle
        };
    }

    dispose(): void {

    }
}

// @extHostNamedCustomer(MainContext.MainThreadSCM)
export class ScmMainImpl implements ScmMain {

    private readonly _proxy: ScmExt;
    private readonly scmService: ScmService;
    private _repositories = new Map<number, ScmRepository>();
    private _repositoryDisposables = new Map<number, DisposableCollection>();
    private readonly _disposables = new DisposableCollection();

    constructor( rpc: RPCProtocol, container: interfaces.Container) {
        this._proxy = rpc.getProxy(MAIN_RPC_CONTEXT.SCM_EXT);
        this.scmService = container.get(ScmService);
    }

    dispose(): void {
        this._repositories.forEach(r => r.dispose());
        this._repositories.clear();

        this._repositoryDisposables.forEach(d => d.dispose());
        this._repositoryDisposables.clear();

        this._disposables.dispose();
    }

    $registerSourceControl(handle: number, id: string, label: string, rootUri: UriComponents | undefined): void {
        const provider = new PluginScmProvider(this._proxy, handle, id, label, rootUri ? vscodeURI.revive(rootUri) : undefined);
        const repository = this.scmService.registerScmProvider(provider, {
                input: {
                    validator: async value => {
                        const result = await this._proxy.$validateInput(handle, value, value.length);
                        return result && { message: result[0], type: result[1] };
                    }
                }
            }
        );
        this._repositories.set(handle, repository);

        const disposables = new DisposableCollection(
            this.scmService.onDidChangeSelectedRepository(r => {
                if (r === repository) {
                    this._proxy.$setSelectedSourceControl(handle);
                }
            }),
            repository.input.onDidChange(() => this._proxy.$onInputBoxValueChange(handle, repository.input.value))
        );

        if (this.scmService.selectedRepository === repository) {
            setTimeout(() => this._proxy.$setSelectedSourceControl(handle), 0);
        }

        if (repository.input.value) {
            setTimeout(() => this._proxy.$onInputBoxValueChange(handle, repository.input.value), 0);
        }

        this._repositoryDisposables.set(handle, disposables);
    }

    $updateSourceControl(handle: number, features: SourceControlProviderFeatures): void {
        const repository = this._repositories.get(handle);

        if (!repository) {
            return;
        }

        const provider = repository.provider as PluginScmProvider;
        provider.$updateSourceControl(features);
    }

    $unregisterSourceControl(handle: number): void {
        const repository = this._repositories.get(handle);

        if (!repository) {
            return;
        }

        this._repositoryDisposables.get(handle)!.dispose();
        this._repositoryDisposables.delete(handle);

        repository.dispose();
        this._repositories.delete(handle);
    }

    $registerGroups(sourceControlHandle: number, groups: [number /* handle*/, string /* id*/, string /* label*/,
        SourceControlGroupFeatures][], splices: SCMRawResourceSplices[]): void {
        const repository = this._repositories.get(sourceControlHandle);

        if (!repository) {
            return;
        }

        const provider = repository.provider as PluginScmProvider;
        provider.$registerGroups(groups);
        provider.$spliceGroupResourceStates(splices);
    }

    $updateGroup(sourceControlHandle: number, groupHandle: number, features: SourceControlGroupFeatures): void {
        const repository = this._repositories.get(sourceControlHandle);

        if (!repository) {
            return;
        }

        const provider = repository.provider as PluginScmProvider;
        provider.$updateGroup(groupHandle, features);
    }

    $updateGroupLabel(sourceControlHandle: number, groupHandle: number, label: string): void {
        const repository = this._repositories.get(sourceControlHandle);

        if (!repository) {
            return;
        }

        const provider = repository.provider as PluginScmProvider;
        provider.$updateGroupLabel(groupHandle, label);
    }

    $spliceResourceStates(sourceControlHandle: number, splices: SCMRawResourceSplices[]): void {
        const repository = this._repositories.get(sourceControlHandle);

        if (!repository) {
            return;
        }

        const provider = repository.provider as PluginScmProvider;
        provider.$spliceGroupResourceStates(splices);
    }

    $unregisterGroup(sourceControlHandle: number, handle: number): void {
        const repository = this._repositories.get(sourceControlHandle);

        if (!repository) {
            return;
        }

        const provider = repository.provider as PluginScmProvider;
        provider.$unregisterGroup(handle);
    }

    $setInputBoxValue(sourceControlHandle: number, value: string): void {
        const repository = this._repositories.get(sourceControlHandle);

        if (!repository) {
            return;
        }

        repository.input.value = value;
    }

    $setInputBoxPlaceholder(sourceControlHandle: number, placeholder: string): void {
        const repository = this._repositories.get(sourceControlHandle);

        if (!repository) {
            return;
        }

        repository.input.placeholder = placeholder;
    }

    $setInputBoxVisibility(sourceControlHandle: number, visible: boolean): void {
        //
    }
}
