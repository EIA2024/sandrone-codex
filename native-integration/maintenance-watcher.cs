using System;
using System.Threading;
using Windows.ApplicationModel;

namespace Sandrone.Maintenance {
    // PowerShell 5.1 cannot subscribe to WinRT events directly. Keep callbacks
    // off its runspace; the worker serializes reconciliation after this signal.
    public sealed class PackageWatcher : IDisposable {
        private readonly PackageCatalog catalog;
        private readonly AutoResetEvent changed = new AutoResetEvent(false);
        public PackageWatcher() {
            catalog = PackageCatalog.OpenForCurrentUser();
            catalog.PackageUpdating += OnUpdating;
            catalog.PackageInstalling += OnInstalling;
        }
        private void OnUpdating(PackageCatalog sender, PackageUpdatingEventArgs args) {
            if (args.TargetPackage.Id.Name == "OpenAI.Codex") changed.Set();
        }
        private void OnInstalling(PackageCatalog sender, PackageInstallingEventArgs args) {
            if (args.Package.Id.Name == "OpenAI.Codex") changed.Set();
        }
        public bool Wait(int milliseconds) { return changed.WaitOne(milliseconds); }
        public void Dispose() {
            catalog.PackageUpdating -= OnUpdating;
            catalog.PackageInstalling -= OnInstalling;
            changed.Dispose();
        }
    }
}
