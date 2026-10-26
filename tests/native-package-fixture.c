#include <windows.h>
#include <stdint.h>
#include <stdbool.h>
typedef void *napi_env;
typedef void *napi_value;
typedef int (*boolean_fn)(napi_env, bool, napi_value *);
typedef int (*set_fn)(napi_env, napi_value, const char *, napi_value);
typedef int (*throw_fn)(napi_env, const char *, const char *);
__declspec(dllexport) int32_t node_api_module_get_api_version_v1(void) { return 8; }
__declspec(dllexport) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    HMODULE runtime = GetModuleHandleW(NULL);
#ifdef FAIL_ORIGINAL
    throw_fn fail = (throw_fn)GetProcAddress(runtime, "napi_throw_error");
    fail(env, "ORIGINAL_FAILURE", "original fixture failure");
#else
    boolean_fn boolean = (boolean_fn)GetProcAddress(runtime, "napi_get_boolean");
    set_fn set = (set_fn)GetProcAddress(runtime, "napi_set_named_property");
    napi_value value;
    boolean(env, true, &value); set(env, exports, "original", value);
#endif
    return exports;
}
