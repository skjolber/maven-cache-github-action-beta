import * as core from "@actions/core";
import { HttpClientResponse, HttpCodes } from "@actions/http-client";

import { DefaultRetryAttempts, DefaultRetryDelay } from "./constants";

export function isSuccessStatusCode(statusCode?: number): boolean {
    if (!statusCode) {
        return false;
    }
    return statusCode >= 200 && statusCode < 300;
}

export function isServerErrorStatusCode(statusCode?: number): boolean {
    if (!statusCode) {
        return true;
    }
    return statusCode >= 500;
}

export function isRetryableStatusCode(statusCode?: number): boolean {
    if (!statusCode) {
        return false;
    }
    const retryableStatusCodes = [
        HttpCodes.BadGateway,
        HttpCodes.ServiceUnavailable,
        HttpCodes.GatewayTimeout
    ];
    return retryableStatusCodes.includes(statusCode);
}

async function sleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function retry<T>(
    name: string,
    method: () => Promise<T>,
    getStatusCode: (arg0: T) => number | undefined,
    maxAttempts = DefaultRetryAttempts,
    delay = DefaultRetryDelay,
    onError: ((arg0: Error) => T | undefined) | undefined = undefined
): Promise<T> {
    let errorMessage = "";
    let attempt = 1;

    while (attempt <= maxAttempts) {
        let response: T | undefined = undefined;
        let statusCode: number | undefined = undefined;
        let isRetryable = false;

        try {
            response = await method();
        } catch (err: unknown) {
            const error = err as Error;
            if (onError) {
                response = onError(error);
            }

            isRetryable = true;
            errorMessage = error.message;
        }

        if (response) {
            statusCode = getStatusCode(response);

            if (!isServerErrorStatusCode(statusCode)) {
                return response;
            }
        }

        if (statusCode) {
            isRetryable = isRetryableStatusCode(statusCode);
            errorMessage = `Cache service responded with ${statusCode}`;
        }

        core.debug(
            `${name} - Attempt ${attempt} of ${maxAttempts} failed with error: ${errorMessage}`
        );

        if (!isRetryable) {
            core.debug(`${name} - Error is not retryable`);
            break;
        }

        await sleep(delay);
        attempt++;
    }

    throw Error(`${name} failed: ${errorMessage}`);
}

export async function retryHttpClientResponse(
    name: string,
    method: () => Promise<HttpClientResponse>,
    maxAttempts = DefaultRetryAttempts,
    delay = DefaultRetryDelay
): Promise<HttpClientResponse> {
    return await retry(
        name,
        method,
        (response: HttpClientResponse) => response.message.statusCode,
        maxAttempts,
        delay
    );
}
