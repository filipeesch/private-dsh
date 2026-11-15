/** Model-facing query for a bundled Python, Node.js, and pnpm payload, in place or installed under the Harness home. */
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, stat, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { WorkspaceDependencyError } from "./error.js";
export { WorkspaceDependencyError } from "./error.js";
/** Cordis plugin identity. */
export const name = 'tool-workspace-dependencies';
/** Registry the tool registers into. */
export const inject = ['tools'];
/** Require a named payload source before the Loader activates the tool. */
export const Config = z.object({
    source: z.string().min(1).required(),
    root: z.string().min(1),
});
function invalidPayload(message, cause) {
    return new WorkspaceDependencyError(message, 'WORKSPACE_DEPENDENCY_INVALID_PAYLOAD', cause === undefined ? undefined : { cause });
}
const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u;
const PLATFORMS = ['win32', 'darwin', 'linux'];
function isVersion(value) {
    return typeof value === 'string' && VERSION.test(value);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isDistributionMap(value) {
    return isRecord(value) && Object.entries(value).every(([name, version]) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)
        && typeof version === 'string' && /^\d[\w.!+-]*$/u.test(version));
}
/**
 * Validate payload JSON and normalize legacy component fields to top-level versions.
 * @param value - Untrusted decoded runtime.json contents.
 * @returns Canonical metadata with one Python distribution map and no components field.
 * @throws {WorkspaceDependencyError} `WORKSPACE_DEPENDENCY_INVALID_PAYLOAD` for malformed or mixed
 *   formats, duplicate distribution names, or inconsistent legacy metadata.
 */
export function parsePrimaryRuntime(value) {
    if (!isRecord(value))
        throw invalidPayload('primary runtime: invalid metadata');
    const legacy = value.components !== undefined;
    const versions = legacy ? value.components : value;
    if (!isRecord(versions) || (legacy && ['python', 'node', 'pnpm'].some(key => value[key] !== undefined))) {
        throw invalidPayload('primary runtime: invalid metadata');
    }
    const { desktopVersion, platform, arch, payloadDigest } = value;
    const { python, node, pnpm } = versions;
    const pythonPackages = value.pythonPackages === undefined && legacy ? {} : value.pythonPackages;
    if (typeof desktopVersion !== 'string' || desktopVersion.length === 0
        || typeof platform !== 'string' || !PLATFORMS.includes(platform)
        || typeof arch !== 'string' || !['x64', 'arm64'].includes(arch)
        || !isVersion(python)
        || (node !== undefined && !isVersion(node))
        || (pnpm !== undefined && (!isVersion(pnpm) || node === undefined))
        || (payloadDigest !== undefined && (typeof payloadDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(payloadDigest)))
        || !isDistributionMap(pythonPackages)) {
        throw invalidPayload('primary runtime: invalid metadata');
    }
    const entries = Object.entries(pythonPackages);
    const distributions = new Map(entries.map(([name, version]) => [name.toLowerCase().replace(/[-_.]+/gu, '-'), version]));
    if (distributions.size !== entries.length)
        throw invalidPayload('primary runtime: invalid metadata');
    // Only the old on-disk format duplicates these versions. New manifests use the distribution map alone.
    if (legacy) {
        for (const name of ['numpy', 'pandas']) {
            if (!isVersion(versions[name]))
                throw invalidPayload('primary runtime: invalid metadata');
            const version = distributions.get(name);
            if (version !== undefined && version !== versions[name]) {
                throw invalidPayload(`primary runtime: conflicting ${name} distribution version`);
            }
        }
    }
    return {
        desktopVersion, platform, arch,
        ...(payloadDigest === undefined ? {} : { payloadDigest }),
        python,
        ...(node === undefined ? {} : { node }),
        ...(pnpm === undefined ? {} : { pnpm }),
        pythonPackages,
    };
}
/**
 * Read and normalize build metadata without rewriting the source file.
 * @param root - Installed or bundled primary runtime directory.
 * @returns Validated top-level versions and target identifiers, including for legacy components manifests.
 * @throws {WorkspaceDependencyError} `WORKSPACE_DEPENDENCY_INVALID_PAYLOAD` when `runtime.json` is missing or
 *   invalid; other read failures, such as `EACCES`, propagate unchanged.
 */
export async function readPrimaryRuntime(root) {
    let text;
    try {
        text = await readFile(join(root, 'runtime.json'), 'utf8');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        throw invalidPayload('primary runtime: runtime.json is missing', error);
    }
    let value;
    try {
        value = JSON.parse(text);
    }
    catch (error) {
        // JSON.parse rejects only with SyntaxError.
        throw invalidPayload(`primary runtime: runtime.json is not valid JSON: ${error.message}`, error);
    }
    return parsePrimaryRuntime(value);
}
/**
 * Identify POSIX interpreter aliases that can survive payload relocation.
 * @param root - Payload directory.
 * @param manifest - Validated payload metadata.
 * @returns Relative alias paths mapped to their sibling interpreter filename; regular command files are omitted.
 * @throws {WorkspaceDependencyError} `WORKSPACE_DEPENDENCY_INVALID_PAYLOAD` when an interpreter alias
 *   does not point directly to the versioned regular file.
 */
export async function primaryRuntimePythonAliases(root, manifest) {
    const aliases = new Map();
    if (manifest.platform === 'win32')
        return aliases;
    const interpreter = `python${manifest.python.split('.').slice(0, 2).join('.')}`;
    for (const name of ['python', 'python3']) {
        const path = `dependencies/python/bin/${name}`;
        let entry;
        try {
            entry = await lstat(join(root, path));
        }
        catch (error) {
            if (error.code === 'ENOENT')
                continue;
            throw error;
        }
        if (!entry.isSymbolicLink())
            continue;
        if (await readlink(join(root, path)) !== interpreter
            || !(await lstat(join(root, 'dependencies/python/bin', interpreter))).isFile()) {
            throw invalidPayload(`primary runtime: invalid Python alias ${path}`);
        }
        aliases.set(path, interpreter);
    }
    return aliases;
}
/**
 * Copy a payload, retaining only validated Python interpreter aliases as relative links.
 * @param source - Payload directory; all other links are materialized.
 * @param destination - Empty destination owned by the caller.
 * @param manifest - Validated source metadata.
 * @returns Resolves after every copied file and interpreter alias is available independently of the source.
 */
export async function copyPrimaryRuntime(source, destination, manifest) {
    const aliases = await primaryRuntimePythonAliases(source, manifest);
    const excluded = new Set([...aliases.keys()].map(path => join(source, path)));
    await cp(source, destination, { recursive: true, dereference: true, filter: path => !excluded.has(path) });
    for (const [path, target] of aliases)
        await symlink(target, join(destination, path));
}
/**
 * Resolve platform-specific interpreter and library locations without changing the environment.
 * @param root - Absolute payload or installation directory.
 * @param manifest - Validated runtime metadata.
 * @returns Absolute paths for explicit script execution and recorded bundled Python versions.
 */
export function workspaceDependencyPaths(root, manifest) {
    const dependencies = join(root, 'dependencies');
    const windows = manifest.platform === 'win32';
    const node = manifest.node === undefined ? {} : {
        node: join(dependencies, 'node', 'bin', windows ? 'node.exe' : 'node'),
        nodePackages: join(dependencies, 'node', 'node_modules'),
    };
    const pnpm = manifest.pnpm === undefined ? {} : { pnpm: join(dependencies, 'pnpm', 'bin', 'pnpm.mjs') };
    return {
        python: join(dependencies, 'python', ...(windows ? ['python.exe'] : ['bin', 'python3'])),
        ...node,
        ...pnpm,
        pythonPackages: join(dependencies, 'python', ...(windows ? ['Lib'] : ['lib', `python${manifest.python.split('.').slice(0, 2).join('.')}`]), 'site-packages'),
        pythonDistributions: manifest.pythonPackages,
    };
}
async function validatePayloadEntries(paths) {
    for (const [path, kind] of [
        [paths.python, 'file'], [paths.node, 'file'], [paths.pnpm, 'file'],
        [paths.pythonPackages, 'directory'], [paths.nodePackages, 'directory'],
    ]) {
        if (path === undefined)
            continue;
        let entry;
        try {
            entry = await stat(path);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            throw invalidPayload(`primary runtime: expected ${kind} at ${path}`, error);
        }
        if (!(kind === 'file' ? entry.isFile() : entry.isDirectory())) {
            throw invalidPayload(`primary runtime: expected ${kind} at ${path}`);
        }
    }
}
async function exists(path) {
    try {
        if ((await lstat(path)).isSymbolicLink())
            throw new Error(`primary runtime: installation path is a filesystem link: ${path}`);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
async function compatibleManifest(source) {
    const manifest = await readPrimaryRuntime(source);
    if (manifest.platform !== process.platform || manifest.arch !== process.arch)
        throw new WorkspaceDependencyError('primary runtime: incompatible platform or architecture', 'WORKSPACE_DEPENDENCY_UNSUPPORTED_PLATFORM');
    return manifest;
}
/**
 * Use a payload where it lies: validate its metadata and entries, copying nothing.
 * @param source - Payload directory, typically a read-only carrier.
 * @returns Paths into the payload itself.
 */
export async function resolvePrimaryRuntime(source) {
    const manifest = await compatibleManifest(source);
    await primaryRuntimePythonAliases(source, manifest);
    const paths = workspaceDependencyPaths(source, manifest);
    await validatePayloadEntries(paths);
    return paths;
}
/**
 * Install the application-owned payload locally, retaining a complete previous tree on copy failure.
 * @param source - Payload carried by the current installation.
 * @param root - Fixed primary runtime directory under the Harness home.
 * @returns Paths into the installed payload; no PATH or package-manager configuration is changed.
 */
export async function installPrimaryRuntime(source, root) {
    const manifest = await compatibleManifest(source);
    await mkdir(dirname(root), { recursive: true });
    const previous = `${root}.previous`;
    const previousExists = await exists(previous);
    const rootExists = await exists(root);
    if (!rootExists && previousExists)
        await rename(previous, root);
    if (await exists(join(root, 'runtime.json')) && JSON.stringify(await readPrimaryRuntime(root)) === JSON.stringify(manifest)) {
        await primaryRuntimePythonAliases(root, manifest);
        const paths = workspaceDependencyPaths(root, manifest);
        await validatePayloadEntries(paths);
        return paths;
    }
    const staging = await mkdtemp(join(dirname(root), '.primary-runtime-'));
    try {
        await copyPrimaryRuntime(source, staging, manifest);
        const paths = workspaceDependencyPaths(staging, manifest);
        await validatePayloadEntries(paths);
        await rm(previous, { recursive: true, force: true });
        const replacing = await exists(root);
        if (replacing)
            await rename(root, previous);
        try {
            await rename(staging, root);
        }
        catch (error) {
            if (replacing)
                await rename(previous, root);
            throw error;
        }
        await rm(previous, { recursive: true, force: true });
    }
    finally {
        await rm(staging, { recursive: true, force: true });
    }
    return workspaceDependencyPaths(root, manifest);
}
/**
 * Register the read-only path query; the first invocation prepares (or merely validates) the payload.
 * @param ctx - Tool registry owner.
 * @param config - Payload location and optional installation directory.
 */
export function apply(ctx, config) {
    if (!isAbsolute(config.source) || (config.root !== undefined && !isAbsolute(config.root))) {
        throw new Error('workspace dependencies: source and root must be absolute paths');
    }
    let preparation;
    ctx.effect(() => async () => {
        // Tool execution reports preparation failures; disposal only waits for filesystem work to settle.
        await preparation?.catch(() => undefined);
    });
    ctx.tools.register(defineTool({
        name: 'load_workspace_dependencies',
        description: 'Get absolute paths to bundled Python and library directories, plus bundled Python distribution versions. Node.js and pnpm paths are included when the payload provides them. Python includes numpy, pandas, python-docx, python-pptx, openpyxl, Pillow, lxml, and XlsxWriter. Use these libraries for Office files unless the user or workspace instructions select another environment. When Node.js and pnpm paths are returned, run pnpm with that Node executable and pnpm script path. This does not change PATH or package-manager settings.',
        parameters: {},
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    python: { type: 'string', required: true },
                    node: { type: 'string', description: 'Absent when the payload ships no Node.js.' },
                    pnpm: { type: 'string', description: 'Absent when the payload ships no pnpm.' },
                    pythonPackages: { type: 'string', required: true },
                    nodePackages: { type: 'string', description: 'Absent when the payload ships no Node.js.' },
                    pythonDistributions: { type: 'object', additionalProperties: true, required: true, description: 'Bundled distribution names and versions recorded in runtime.json; excludes user-installed additions.' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
        },
        execute: () => {
            preparation ??= (config.root === undefined ? resolvePrimaryRuntime(config.source) : installPrimaryRuntime(config.source, config.root))
                .catch((error) => {
                preparation = undefined;
                if (error instanceof WorkspaceDependencyError)
                    throw error;
                // Preparation runs only filesystem calls and local checks, which reject with Error instances.
                throw new WorkspaceDependencyError(`primary runtime: preparation failed: ${error.message}`, 'WORKSPACE_DEPENDENCY_PREPARATION_FAILED', { cause: error });
            });
            return preparation;
        },
        presentCall: () => ({ card: 'generic', title: 'Load workspace dependencies', kind: 'read' }),
    }));
}
//# sourceMappingURL=index.js.map