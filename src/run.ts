// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as core from '@actions/core';
import * as ioUtil from '@actions/io/lib/io-util';
import { ExecOptions } from "@actions/exec/lib/interfaces";
import * as utilities from "./utilities"
import * as path from 'path';
import * as fs from 'fs';
import * as util from 'util';
import { getHelmPath, NameValuePair } from "./helm-util"
import { getKubectlPath } from "./kubectl-util"
import { getKomposePath } from "./kompose-util"


abstract class RenderEngine {
    public bake!: () => Promise<any>;
    protected getTemplatePath = () => {
        const tempDirectory = process.env['RUNNER_TEMP'];
        if(!!tempDirectory) {
            return path.join(tempDirectory, 'baked-template-' + utilities.getCurrentTime().toString() + '.yaml');
        }
        else {
            throw Error("Unable to create temp directory.");
        }
    }
}

class HelmRenderEngine extends RenderEngine {
    public bake = async (): Promise<any> => {
        core.log("in HelmRenderEngine");                
        const helmPath = await getHelmPath();
        core.debug("Creating the template argument string..");
        var args = this.getTemplateArgs()
         const options = {
            silent: true
         } as ExecOptions;
        
        core.debug("Running helm template command..");
        var result = await utilities.execCommand(helmPath, args, options)
        const pathToBakedManifest = this.getTemplatePath();
        fs.writeFileSync(pathToBakedManifest, result.stdout);
        core.setOutput('manifestsBundle', pathToBakedManifest);
    }

    private getOverrideValues(overrides: string[]) {
        const overrideValues: NameValuePair[] = [];
        overrides.forEach(arg => {
            const overrideInput = arg.split(':');
            const overrideName = overrideInput[0];
            const overrideValue = overrideInput.slice(1).join(':');
            overrideValues.push({
                name: overrideName,
                value: overrideValue
            } as NameValuePair);
        });

        return overrideValues;
    }

    private getTemplateArgs(): string[] {
        const releaseName = core.getInput('releaseName', {required : false});
        const chartPath = core.getInput('helmChart', {required : true});

        let args: string[] = [];
        args.push('template');
        args.push(chartPath);
        if (releaseName) {
            args.push('--name');
            args.push(releaseName);
        }
        var overrideFilesInput = core.getInput('overrideFiles', { required: false });
        if (!!overrideFilesInput) {
            core.debug("Adding overrides file inputs");
            var overrideFiles = overrideFilesInput.split('\n');
            if (overrideFiles.length > 0) {
                overrideFiles.forEach(file => {
                    args.push('-f');
                    args.push(file);
                });
            }
        }

        var overridesInput = core.getInput('overrides', { required: false });
        if (!!overridesInput) {
            core.debug("Adding overrides inputs");
            var overrides = overridesInput.split('\n');
            if (overrides.length > 0) {
                var overrideValues = this.getOverrideValues(overrides);
                overrideValues.forEach(overrideValue => {
                    args.push('--set');
                    args.push(`${overrideValue.name}=${overrideValue.value}`);
                });
            }
        }

        return args;
    }
}

class KomposeRenderEngine extends RenderEngine {
    public bake = async (): Promise<any> => {
        var dockerComposeFilePath = core.getInput('dockerComposeFile', { required : true });
        if( !ioUtil.exists(dockerComposeFilePath) ) {
            throw Error(util.format("Docker compose file path %s does not exist. Please check the path specified", dockerComposeFilePath));
        }

        const komposePath = await getKomposePath(); 
        const pathToBakedManifest = this.getTemplatePath();
        core.debug("Running kompose command..");
        await utilities.execCommand(komposePath, ['convert', '-f', dockerComposeFilePath, '-o', pathToBakedManifest])
        core.setOutput('manifestsBundle', pathToBakedManifest);
    }
}

class KustomizeRenderEngine extends RenderEngine {
    public bake = async () => {
        const kubectlPath = await getKubectlPath();
        await this.validateKustomize(kubectlPath);
        var kustomizationPath = core.getInput('kustomizationPath', { required: true });
        if( !ioUtil.exists(kustomizationPath) ) {
            throw Error(util.format("kustomizationPath %s does not exist. Please check whether file exists or not.", kustomizationPath));
        }
        
        const options = {
            silent: true
        } as ExecOptions;

        core.debug("Running kubectl kustomize command..");
        console.log(`[command] ${kubectlPath} kustomize ${core.getInput('kustomizationPath')}`);
        var result = await utilities.execCommand(kubectlPath, ['kustomize', kustomizationPath], options);
        const pathToBakedManifest = this.getTemplatePath();
        fs.writeFileSync(pathToBakedManifest, result.stdout);
        core.setOutput('manifestsBundle', pathToBakedManifest);
    };

    private async validateKustomize(kubectlPath: string) {
        var result = await utilities.execCommand(kubectlPath, ['version', '--client=true', '-o', 'json']);
        if(!!result.stdout) {
            const clientVersion = JSON.parse(result.stdout).clientVersion;
            if (clientVersion && parseInt(clientVersion.major) >= 1 && parseInt(clientVersion.minor) >= 14) {
                // Do nothing
            } 
            else {
                throw new Error("kubectl client version equal to v1.14 or higher is required to use kustomize features");
            }
        }
    }
}

async function run() {
    const renderType = core.getInput('renderEngine', { required: true });
    let renderEngine: RenderEngine;
    console.log("in run");
    core.debug("in run");
    switch (renderType) {
        case 'helm2':
            renderEngine = new HelmRenderEngine();
            break;
        case 'kompose':
            renderEngine = new KomposeRenderEngine();
            break;
        case 'kustomize':
            renderEngine = new KustomizeRenderEngine();
            break;
        default:
            throw Error("Unknown render engine");
    }

    try {
        await renderEngine.bake();
    }
    catch(err) {
        throw Error(util.format("Failed to run bake action. Error: %s", err));
    }
}

run().catch(core.setFailed);
