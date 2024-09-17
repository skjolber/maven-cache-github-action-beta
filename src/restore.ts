import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as glob from "@actions/glob";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as stream from "stream";
import * as util from "util";

import {
    DefaultGitHistoryDepth,
    Events,
    Inputs,
    MavenWrapperPath,
    MavenWrapperPropertiesPath,
    MaxCacheKeys,
    Restore,
    RestoreKeyPath,
    State
} from "./constants";
import * as utils from "./utils/actionUtils";
import * as maven from "./utils/maven";

class GitOutput {
    standardOut: string;
    errorOut: string;

    constructor(standardOut: string, errorOut: string) {
        this.standardOut = standardOut;
        this.errorOut = errorOut;
    }

    getStandardOut() {
        return this.standardOut;
    }

    getErrorOut() {
        return this.errorOut;
    }

    standardOutAsString() {
        return this.standardOut.trim();
    }

    standardOutAsStringArray() {
        return this.standardOut
            .split("\n")
            .map(s => s.trim())
            .filter(x => x !== "");
    }
}

async function getCommitLogTarget(): Promise<string | undefined> {
    // git show --pretty=raw
    const showOutput = await runGitCommand(["show", "--pretty=raw"]);

    const show = showOutput.standardOutAsString();

    const search = "parent ";

    const index = show.indexOf(search);
    if (index != -1) {
        const endIndex = show.indexOf("\n", index + search.length);
        if (endIndex != -1) {
            return show.substring(index + search.length, endIndex);
        }
    }
    return undefined;
}

async function runGitCommand(parameters: Array<string>): Promise<GitOutput> {
    let standardOut = "";
    let errorOut = "";

    await exec.exec("git", parameters, {
        silent: true,
        failOnStdErr: false,
        ignoreReturnCode: false,
        listeners: {
            stdout: (data: Buffer) => {
                standardOut += data.toString();
            },
            stderr: (data: Buffer) => {
                errorOut += data.toString();
            }
        }
    });

    return new GitOutput(standardOut, errorOut);
}

async function findFiles(matchPatterns: Array<string>): Promise<Array<string>> {
    const buildFiles = new Array<string>();

    let followSymbolicLinks = false;
    if (process.env.followSymbolicLinks === "true") {
        console.log("Follow symbolic links");
        followSymbolicLinks = true;
    }

    const githubWorkspace = process.cwd();
    const prefix = `${githubWorkspace}${path.sep}`;

    for (const matchPattern of matchPatterns) {
        const globber = await glob.create(matchPattern, {
            followSymbolicLinks: followSymbolicLinks
        });
        for await (const file of globber.globGenerator()) {
            if (!file.startsWith(prefix)) {
                console.log(
                    `Ignore '${file}' since it is not under GITHUB_WORKSPACE.`
                );
                continue;
            }
            if (fs.statSync(file).isDirectory()) {
                console.log(`Skip directory '${file}'.`);
                continue;
            }
            console.log(`Found ${file}`);

            buildFiles.push(file);
        }
    }
    return buildFiles;
}

async function restoreCache(keys: Array<string>): Promise<string | undefined> {
    for (let offset = 0; offset < keys.length; offset += MaxCacheKeys) {
        const limit = Math.min(offset + MaxCacheKeys, keys.length);

        const subkeys = keys.slice(offset, limit);

        const firstSubkey = subkeys[0];
        subkeys.shift();

        const enableCrossOsArchive = utils.getInputAsBool(
            Inputs.EnableCrossOsArchive
        );

        const cachePaths = utils.getCachePaths();

        const cacheKey = await cache.restoreCache(
            cachePaths,
            firstSubkey,
            subkeys,
            { lookupOnly: false },
            enableCrossOsArchive
        );

        if (cacheKey) {
            return cacheKey;
        }
    }
    return undefined;
}

async function getFileHash(files: Array<string>) {
    const result = crypto.createHash("sha256");
    for (const file of files) {
        const hash = crypto.createHash("sha256");
        const pipeline = util.promisify(stream.pipeline);
        await pipeline(fs.createReadStream(file), hash);
        result.write(hash.digest());
    }
    result.end();

    return result.digest("hex");
}

export async function saveWrapperCache() {
    // simple file-hash based wrapper cache

    console.log("Save wrapper cache");

    const wrapperState = core.getState(State.Wrapper);
    if (wrapperState == "pending") {
        const files = await findFiles([MavenWrapperPropertiesPath]);
        if (files.length > 0) {
            if (utils.isMavenWrapperDirectory()) {
                const hash = await getFileHash(files);

                const enableCrossOsArchive = utils.getInputAsBool(
                    Inputs.EnableCrossOsArchive
                );

                const cacheKeyPrefix = utils.getCacheKeyPrefix();

                try {
                    console.log("Saving maven wrapper..");
                    const result = await cache.saveCache(
                        [MavenWrapperPath],
                        cacheKeyPrefix + hash,
                        {
                            uploadChunkSize: utils.getInputAsInt(
                                Inputs.UploadChunkSize
                            )
                        },
                        enableCrossOsArchive
                    );
                    console.log("Saved maven wrapper.");
                    return result;
                } catch (err) {
                    const error = err as Error;
                    if (error.name === cache.ValidationError.name) {
                        throw error;
                    } else if (error.name === cache.ReserveCacheError.name) {
                        core.info(error.message);
                    } else {
                        utils.logWarning(error.message);
                    }
                    console.log("Unable to save maven wrapper.");
                }
            } else {
                console.log(
                    "Not saving wrapper, directory " +
                        MavenWrapperPath +
                        " does not exist."
                );
            }
        } else {
            console.log(
                "Not saving wrapper, no files found for " +
                    MavenWrapperPropertiesPath +
                    "."
            );
        }
    } else {
        console.log("Not saving wrapper for state " + wrapperState + ".");
    }
    return undefined;
}

export async function restoreWrapperCache() {
    // simple file-hash based wrapper cache

    const files = await findFiles([MavenWrapperPropertiesPath]);
    if (files.length > 0) {
        const hash = await getFileHash(files);

        const enableCrossOsArchive = utils.getInputAsBool(
            Inputs.EnableCrossOsArchive
        );

        const cacheKeyPrefix = utils.getCacheKeyPrefix();

        console.log("Restoring maven wrapper..");
        const cacheKey = await cache.restoreCache(
            [MavenWrapperPath],
            cacheKeyPrefix + hash,
            [],
            { lookupOnly: false },
            enableCrossOsArchive
        );

        if (cacheKey) {
            console.log("Restored maven wrapper.");

            core.saveState(State.Wrapper, "restored");

            return cacheKey;
        }
        console.log("Unable to restore maven wrapper, cache miss.");

        // save wrapper once build completes
        core.saveState(State.Wrapper, "pending");
    } else {
        console.log(
            "Not restoring wrapper, no files fount for " +
                MavenWrapperPropertiesPath +
                "."
        );
        core.saveState(State.Wrapper, "disabled");
    }
    return undefined;
}

/*
Overall plan:

 - search for the relevant build files in the file system
 - if no build files, cache cannot be restored
 - fetch the last n commits of the git history
 - search git history for changes to the build files, get commit hashes
 - if not commit hashes, go by file content hashes
 - search commit history for manual cache resets; filter older commit hashes
 - construct cache keys; two for each hash (success and failure variants)
 - attempt to restore caches, in steps.
 - if hit on the primary (success) key, skip persisting caches. In other words do not prepare/perform a cleanup either.
 - if hit on the secondary (failure) key, persist the cache on successful build
 - otherwise persist the cache.
   - if successful build, clean and persist cache
   - if failed build, just persist cache

*/
async function run(): Promise<void> {
    try {
        const step = core.getInput(Inputs.Step, { required: true });
        core.saveState(State.Step, step);
        if (step === "restore") {
            if (utils.isGhes()) {
                utils.logWarning("Cache action is not supported on GHES");
                utils.setCacheRestoreOutput(Restore.None);
                return;
            }

            // https://github.com/actions/runner/blob/c18c8746db0b7662a13da5596412c05c1ffb07dd/src/Misc/expressionFunc/hashFiles/src/hashFiles.ts

            // Validate inputs, this can cause task failure
            if (!utils.isValidEvent()) {
                utils.logWarning(
                    `Event Validation Error: The event type ${
                        process.env[Events.Key]
                    } is not supported because it's not tied to a branch or tag ref.`
                );
                return;
            }

            const parameterCacheKeyPrefix = utils.getCacheKeyPrefix();

            const keyPaths = utils.getKeyPaths();

            const files = await findFiles(keyPaths);
            if (files.length == 0) {
                utils.logWarning(
                    "No key files found for expression " +
                        keyPaths +
                        ", cache cannot be restored"
                );
                return;
            }

            const depth =
                core.getInput(Inputs.Depth, { required: false }) ||
                DefaultGitHistoryDepth;
            await runGitCommand(["fetch", "--deepen=" + depth]);

            const githubWorkspace = process.cwd();
            const prefix = `${githubWorkspace}${path.sep}`;

            const gitFiles = new Array<string>();
            for (const file of files) {
                const fileInGitRepo = file.substring(prefix.length);
                gitFiles.push(fileInGitRepo);

                console.log("Build file " + fileInGitRepo);
            }

            let logTarget = "HEAD";
            // check whether we are on a PR or
            const gitRevParse = await runGitCommand([
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "HEAD"
            ]);

            const detached =
                gitRevParse.standardOutAsString().trim() === "HEAD";
            if (detached) {
                // ups, on a detached branch, most likely a pull request
                // so no history is available
                console.log("Try to determine parent for detached commit");
                const detachedLogTarget = await getCommitLogTarget();
                if (detachedLogTarget) {
                    logTarget = detachedLogTarget;
                    console.log("Found detached parent " + logTarget);
                } else {
                    console.log("Unable to determine detached parent");
                }
            }

            let hashes = new Array<string>();

            if (detached) {
                const gitFilesHashOutput = await runGitCommand(
                    ["log", "--pretty=format:%H", "--"].concat(gitFiles)
                );
                for (const hash of gitFilesHashOutput.standardOutAsStringArray()) {
                    hashes.push(hash);
                }
            }

            const gitFilesHashOutput = await runGitCommand(
                ["log", "--pretty=format:%H", logTarget, "--"].concat(gitFiles)
            );
            for (const hash of gitFilesHashOutput.standardOutAsStringArray()) {
                hashes.push(hash);
            }
            console.log("Found " + hashes.length + " hashes");
            // get the commit hash messages
            const commmitHashMessages = new Array<string>();
            if (detached) {
                const commitMessages = await runGitCommand([
                    "log",
                    "--format=%H %B"
                ]);
                for (const hash of commitMessages.standardOutAsStringArray()) {
                    commmitHashMessages.push(hash);
                }
            }
            const commitMessages = await runGitCommand([
                "log",
                "--format=%H %B",
                logTarget
            ]);
            for (const hash of commitMessages.standardOutAsStringArray()) {
                commmitHashMessages.push(hash);
            }

            const restoreKeys = new Array<string>();
            if (hashes.length > 0) {
                // check commit history for [cache clear] messages,
                // delete all previous hash commits up to and including [cache clear], insert the [cache clear] itself
                // check commit messages for [cache clear] commit messages
                const commitIndex =
                    utils.searchCommitMessages(commmitHashMessages);
                if (commitIndex != -1) {
                    console.log(
                        `Cache cleaned in commit ${commmitHashMessages[commitIndex]}. Ignore all previous caches.`
                    );

                    // determine which commits should be ejected
                    // scan through all later commits from the [clear cache] message
                    // and nuke all hash keys if a match is found
                    for (
                        let k = commitIndex;
                        k < commmitHashMessages.length;
                        k++
                    ) {
                        const str = commmitHashMessages[k];
                        const h = str.substring(0, str.indexOf(" "));
                        const index = hashes.indexOf(h);
                        if (index > -1) {
                            hashes = hashes.splice(0, index);
                            break;
                        }
                    }

                    // add the commit with the [clean cache] as a potential cache restore point
                    const str = commmitHashMessages[commitIndex];
                    hashes.push(str.substring(0, str.indexOf(" ")));
                }

                console.log(
                    `Will attempt for restore cache from ${hashes.length} commits`
                );

                for (const hash of hashes) {
                    restoreKeys.push(
                        `${parameterCacheKeyPrefix}-${hash}-success`
                    );
                    restoreKeys.push(
                        `${parameterCacheKeyPrefix}-${hash}-failure`
                    );
                }
            } else {
                // search all of history for a [clear cache] message
                const commitIndex =
                    utils.searchCommitMessages(commmitHashMessages);
                if (commitIndex != -1) {
                    console.log(
                        `Cache cleaned in commit ${commmitHashMessages[commitIndex]}. Ignore all previous caches.`
                    );

                    restoreKeys.push(
                        `${parameterCacheKeyPrefix}-${commmitHashMessages[commitIndex]}-success`
                    );
                    restoreKeys.push(
                        `${parameterCacheKeyPrefix}-${commmitHashMessages[commitIndex]}-failure`
                    );
                } else {
                    console.log(
                        "No git history found for build files, fall back to using file hash instead"
                    );

                    const hashAsString = await getFileHash(files);

                    restoreKeys.push(
                        `${parameterCacheKeyPrefix}-${hashAsString}-success`
                    );
                    restoreKeys.push(
                        `${parameterCacheKeyPrefix}-${hashAsString}-failure`
                    );
                }
            }

            const restoreKeySuccess = restoreKeys[0];
            const restoreKeyFailure = restoreKeys[1];

            try {
                const cacheKey = await restoreCache(restoreKeys);

                if (!cacheKey) {
                    console.log(
                        "No cache found for current or previous build files. Expect to save a new cache."
                    );
                    utils.setCacheRestoreOutput(Restore.None);

                    utils.ensureMavenDirectoryExists();
                    console.log(
                        "If build is successful, save to key " +
                            restoreKeySuccess +
                            ". If build fails, save to " +
                            restoreKeyFailure
                    );
                    fs.writeFileSync(
                        utils.toAbsolutePath(RestoreKeyPath),
                        restoreKeySuccess
                    );
                    core.saveState(State.FailureHash, restoreKeyFailure);

                    // no point in cleaning cache
                } else {
                    const primaryMatch =
                        cacheKey != null &&
                        utils.isExactKeyMatch(restoreKeySuccess, cacheKey);
                    if (primaryMatch) {
                        core.info(`Cache is up to date.`);
                        utils.setCacheRestoreOutput(Restore.Full);
                    } else {
                        const secondaryMatch =
                            cacheKey != null &&
                            utils.isExactKeyMatch(restoreKeyFailure, cacheKey);
                        if (secondaryMatch) {
                            core.info(
                                `Cache was left over after a failed build, expect to clean and save a new cache if build is successful.`
                            );
                            utils.ensureMavenDirectoryExists();

                            console.log(
                                "If build is successful, save to key " +
                                    restoreKeySuccess +
                                    ". If build fails, save to " +
                                    restoreKeyFailure
                            );
                            fs.writeFileSync(
                                utils.toAbsolutePath(RestoreKeyPath),
                                restoreKeySuccess
                            );

                            // i.e. do not save another cache if the build fails again
                        } else {
                            core.info(
                                `Cache is outdated, expect to save a new cache.`
                            );
                            console.log(
                                "If build is successful, save to key " +
                                    restoreKeySuccess +
                                    ". If build fails, save to " +
                                    restoreKeyFailure
                            );
                            utils.ensureMavenDirectoryExists();
                            fs.writeFileSync(
                                utils.toAbsolutePath(RestoreKeyPath),
                                restoreKeySuccess
                            );

                            core.saveState(
                                State.FailureHash,
                                restoreKeyFailure
                            );

                            core.saveState(
                                State.EnableCrossOsArchive,
                                utils.getInputAsBool(
                                    Inputs.EnableCrossOsArchive
                                )
                            );

                            const uploadChunkSize = utils.getInputAsInt(
                                Inputs.UploadChunkSize
                            );

                            // note: might be undefined
                            core.saveState(
                                State.UploadChunkSize,
                                uploadChunkSize ? uploadChunkSize : -1
                            );
                        }
                        utils.setCacheRestoreOutput(Restore.Partial);

                        maven.prepareCleanup();
                    }
                }
            } catch (err: unknown) {
                const error = err as Error;
                if (error.name === cache.ValidationError.name) {
                    throw error;
                } else {
                    utils.logWarning(error.message);
                    utils.setCacheRestoreOutput(Restore.None);
                }
            }

            const wrapper = utils.getInputAsBool(Inputs.Wrapper);
            if (wrapper) {
                try {
                    await restoreWrapperCache();
                } catch (err: unknown) {
                    console.log("Problem restoring wrapper cache", err);
                }
            } else {
                core.saveState(State.Wrapper, "disabled");
            }
        } else if (step === "save") {
            try {
                const absolutePath = utils.toAbsolutePath(RestoreKeyPath);
                if (fs.existsSync(absolutePath)) {
                    console.log("Save cache for successful build..");

                    //file exists
                    const successKey = fs.readFileSync(absolutePath, {
                        encoding: "utf8",
                        flag: "r"
                    });

                    const cachePaths = utils.getCachePaths();

                    await maven.performCleanup(cachePaths);

                    const enableCrossOsArchive = utils.getInputAsBool(
                        Inputs.EnableCrossOsArchive
                    );

                    try {
                        await cache.saveCache(
                            cachePaths,
                            successKey,
                            {
                                uploadChunkSize: utils.getInputAsInt(
                                    Inputs.UploadChunkSize
                                )
                            },
                            enableCrossOsArchive
                        );
                    } catch (err) {
                        const error = err as Error;
                        if (error.name === cache.ValidationError.name) {
                            throw error;
                        } else if (
                            error.name === cache.ReserveCacheError.name
                        ) {
                            core.info(error.message);
                        } else {
                            utils.logWarning(error.message);
                        }
                    }
                } else {
                    console.error(
                        "Skip saving cache for successful build; cache is already up to date."
                    );
                }
            } catch (err) {
                console.error(err);
            }

            try {
                await saveWrapperCache();
            } catch (err: unknown) {
                console.log("Problem saving wrapper cache", err);
            }
        } else {
            core.setFailed("Step must be 'restore' or 'save'");
        }
    } catch (err) {
        const error = err as Error;
        core.setFailed(error.message);
    }
}

run();

export default run;
