// Preserve the original Windows updater exports; load the optional theme only
// after successful registration. This is a version-bound local adapter.
#include <windows.h>
#include <stdint.h>
#include <stdbool.h>
#include <wchar.h>

typedef void *napi_env;
typedef void *napi_value;
typedef napi_value (*register_fn)(napi_env, napi_value);
typedef int32_t (*version_fn)(void);
typedef int (*string_fn)(napi_env, const char *, size_t, napi_value *);
typedef int (*run_fn)(napi_env, napi_value, napi_value *);
typedef int (*clear_fn)(napi_env, napi_value *);
typedef int (*pending_fn)(napi_env, bool *);
typedef int (*throw_fn)(napi_env, const char *, const char *);
static HMODULE self_module, original_module;

static HMODULE original(void) {
    if (original_module) return original_module;
    wchar_t filename[32768];
    DWORD length = GetModuleFileNameW(self_module, filename, 32768);
    if (!length || length >= 32768) return NULL;
    wchar_t *slash = wcsrchr(filename, L'\\');
    if (!slash || (size_t)(slash - filename) + 31 >= 32768) return NULL;
    wcscpy(slash + 1, L"windows-updater.original.node");
    original_module = LoadLibraryExW(filename, NULL,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    return original_module;
}

__declspec(dllexport) int32_t node_api_module_get_api_version_v1(void) {
    HMODULE module = original();
    version_fn version = module ? (version_fn)GetProcAddress(module, "node_api_module_get_api_version_v1") : NULL;
    // A missing module is reported as an exception in registration below.
    return version ? version() : 8;
}

__declspec(dllexport) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    HMODULE module = original();
    register_fn init = module ? (register_fn)GetProcAddress(module, "napi_register_module_v1") : NULL;
    HMODULE runtime = GetModuleHandleW(L"chrome.dll");
    if (!runtime) runtime = GetModuleHandleW(NULL);
    if (!init) {
        throw_fn fail = (throw_fn)GetProcAddress(runtime, "napi_throw_error");
        if (fail) fail(env, "SANDRONE_ORIGINAL_MODULE_MISSING", "Original Windows updater module could not be loaded. Remove the Sandrone add-on.");
        return NULL;
    }
    napi_value result = init(env, exports);
    pending_fn pending = (pending_fn)GetProcAddress(runtime, "napi_is_exception_pending");
    bool has_exception = false;
    // Never swallow errors raised by the original updater.
    if (!result || !pending || pending(env, &has_exception) != 0 || has_exception) return result;
    string_fn make = (string_fn)GetProcAddress(runtime, "napi_create_string_utf8");
    run_fn run = (run_fn)GetProcAddress(runtime, "napi_run_script");
    clear_fn clear = (clear_fn)GetProcAddress(runtime, "napi_get_and_clear_last_exception");
    if (make && run && clear) {
        napi_value source, value;
        const char *script = "(()=>{if(process.type==='browser'){const req=process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/package.json');req(process.resourcesPath+'/native/sandrone/runtime/main.cjs');}})()";
        if (make(env, script, (size_t)-1, &source) == 0 && run(env, source, &value) != 0) {
            // Only the optional theme's failure is cleared, after registration.
            if (pending(env, &has_exception) == 0 && has_exception) clear(env, &value);
        }
    }
    return result;
}

BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        self_module = module;
        DisableThreadLibraryCalls(module);
    }
    return TRUE;
}
