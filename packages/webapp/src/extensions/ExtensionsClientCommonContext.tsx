import { ControllerProps as GenericExtensionsControllerProps } from '@sourcegraph/extensions-client-common/lib/client/controller'
import {
    ExtensionsProps as GenericExtensionsProps,
    UpdateExtensionSettingsArgs,
} from '@sourcegraph/extensions-client-common/lib/context'
import { Controller as ExtensionsContextController } from '@sourcegraph/extensions-client-common/lib/controller'
import { ConfiguredExtension } from '@sourcegraph/extensions-client-common/lib/extensions/extension'
import { QueryResult } from '@sourcegraph/extensions-client-common/lib/graphql'
import * as ECCGQL from '@sourcegraph/extensions-client-common/lib/schema/graphqlschema'
import {
    ConfigurationCascadeProps as GenericConfigurationCascadeProps,
    ConfigurationSubject,
    gqlToCascade,
    Settings,
} from '@sourcegraph/extensions-client-common/lib/settings'
import { isEqual } from 'lodash'
import MenuDownIcon from 'mdi-react/MenuDownIcon'
import MenuIcon from 'mdi-react/MenuIcon'
import { concat, Observable } from 'rxjs'
import { distinctUntilChanged, map, switchMap, take, withLatestFrom } from 'rxjs/operators'
import { InitData } from 'sourcegraph/module/extension/extensionHost'
import { MessageTransports } from 'sourcegraph/module/protocol/jsonrpc2/connection'
import { createWebWorkerMessageTransports } from 'sourcegraph/module/protocol/jsonrpc2/transports/webWorker'
import ExtensionHostWorker from 'worker-loader!./extensionHost.worker'
import { authenticatedUser } from '../auth'
import { gql, queryGraphQL } from '../backend/graphql'
import * as GQL from '../backend/graphqlschema'
import { sendLSPHTTPRequests } from '../backend/lsp'
import { Tooltip } from '../components/tooltip/Tooltip'
import { editConfiguration } from '../configuration/backend'
import { configurationCascade, toGQLKeyPath } from '../settings/configuration'
import { refreshConfiguration } from '../user/settings/backend'
import { ErrorLike, isErrorLike } from '../util/errors'

export interface ExtensionsControllerProps extends GenericExtensionsControllerProps<ConfigurationSubject, Settings> {}

export interface ConfigurationCascadeProps extends GenericConfigurationCascadeProps<ConfigurationSubject, Settings> {}

export interface ExtensionsProps extends GenericExtensionsProps<ConfigurationSubject, Settings> {}

export function createExtensionsContextController(): ExtensionsContextController<ConfigurationSubject, Settings> {
    return new ExtensionsContextController<ConfigurationSubject, Settings>({
        configurationCascade: configurationCascade.pipe(
            map(gqlToCascade),
            distinctUntilChanged((a, b) => isEqual(a, b))
        ),
        updateExtensionSettings: (subject, args) => updateExtensionSettings(subject, args),
        queryGraphQL: (request, variables) =>
            queryGraphQL(
                gql`
                    ${request}
                `,
                variables
            ) as Observable<QueryResult<Pick<ECCGQL.IQuery, 'extensionRegistry' | 'repository'>>>,
        queryLSP: requests => sendLSPHTTPRequests(requests),
        icons: {
            CaretDown: MenuDownIcon as React.ComponentType<{ className: string; onClick?: () => void }>,
            Menu: MenuIcon as React.ComponentType<{ className: string; onClick?: () => void }>,
        },
        forceUpdateTooltip: () => Tooltip.forceUpdate(),
    })
}

function updateExtensionSettings(subject: string, args: UpdateExtensionSettingsArgs): Observable<void> {
    return configurationCascade.pipe(
        take(1),
        withLatestFrom(authenticatedUser),
        switchMap(([configurationCascade, authenticatedUser]) => {
            const subjectConfig = configurationCascade.subjects.find(s => s.id === subject)
            if (!subjectConfig) {
                throw new Error(`no configuration subject: ${subject}`)
            }
            const lastID = subjectConfig.latestSettings ? subjectConfig.latestSettings.id : null

            let edit: GQL.IConfigurationEdit
            let editDescription: string
            if ('edit' in args && args.edit) {
                edit = { keyPath: toGQLKeyPath(args.edit.path), value: args.edit.value }
                editDescription = `update user setting ` + '`' + args.edit.path + '`'
            } else if ('extensionID' in args) {
                edit = {
                    keyPath: toGQLKeyPath(['extensions', args.extensionID]),
                    value: typeof args.enabled === 'boolean' ? args.enabled : null,
                }
                editDescription =
                    `${typeof args.enabled === 'boolean' ? 'enable' : 'disable'} extension ` +
                    '`' +
                    args.extensionID +
                    '`'
            } else {
                throw new Error('no edit')
            }

            if (!authenticatedUser) {
                const u = new URL(window.context.appURL)
                throw new Error(
                    `Unable to ${editDescription} because you are not signed in.` +
                        '\n\n' +
                        `[**Sign into Sourcegraph${
                            u.hostname === 'sourcegraph.com' ? '' : ` on ${u.host}`
                        }**](${`${u.href.replace(/\/$/, '')}/sign-in`})`
                )
            }

            return editConfiguration(subject, lastID, edit)
        }),
        switchMap(() => concat(refreshConfiguration(), [void 0]))
    )
}

export function updateHighestPrecedenceExtensionSettings(args: {
    extensionID: string
    enabled?: boolean
}): Observable<void> {
    return configurationCascade.pipe(
        take(1),
        switchMap(configurationCascade => {
            // Only support configuring extension settings in user settings with this action.
            const subject = configurationCascade.subjects[configurationCascade.subjects.length - 1]
            return updateExtensionSettings(subject.id, args)
        })
    )
}

export function createMessageTransports(
    extension: Pick<ConfiguredExtension, 'id' | 'manifest'>
): Promise<MessageTransports> {
    if (!extension.manifest) {
        throw new Error(`unable to run extension ${JSON.stringify(extension.id)}: no manifest found`)
    }
    if (isErrorLike(extension.manifest)) {
        throw new Error(
            `unable to run extension ${JSON.stringify(extension.id)}: invalid manifest: ${extension.manifest.message}`
        )
    }

    if (extension.manifest.url) {
        const url = extension.manifest.url
        return fetch(url, { credentials: 'same-origin' })
            .then(resp => {
                if (resp.status !== 200) {
                    return resp
                        .text()
                        .then(text => Promise.reject(new Error(`loading bundle from ${url} failed: ${text}`)))
                }
                return resp.text()
            })
            .then(bundleSource => {
                const blobURL = window.URL.createObjectURL(
                    new Blob([bundleSource], {
                        type: 'application/javascript',
                    })
                )
                try {
                    const worker = new ExtensionHostWorker()
                    const initData: InitData = {
                        bundleURL: blobURL,
                        sourcegraphURL: window.context.appURL,
                        clientApplication: 'sourcegraph',
                    }
                    worker.postMessage(initData)
                    return createWebWorkerMessageTransports(worker)
                } catch (err) {
                    console.error(err)
                }
                throw new Error('failed to initialize extension host')
            })
    }
    throw new Error(`unable to run extension ${JSON.stringify(extension.id)}: no "url" property in manifest`)
}

/** Reports whether the given extension is mentioned (enabled or disabled) in the settings. */
export function isExtensionAdded(settings: Settings | ErrorLike | null, extensionID: string): boolean {
    return !!settings && !isErrorLike(settings) && !!settings.extensions && extensionID in settings.extensions
}
