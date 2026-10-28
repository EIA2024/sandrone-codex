// Preference changes are serialized across all Codex windows. The renderer
// sends named actions only; it never chooses a command, path or script.
class ThemeManager {
  constructor(preferences, operations) {
    this.preferences = { ...preferences };
    this.operations = operations;
    this.uninstallStatus = 'idle';
    this.error = '';
    this.queue = Promise.resolve();
  }

  snapshot() {
    return { ...this.preferences, uninstallStatus: this.uninstallStatus, error: this.error };
  }

  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async setEnabled(enabled) {
    if (enabled && ['scheduled', 'removing', 'completed'].includes(this.uninstallStatus)) {
      throw new Error('请先取消待执行的卸载，再启用主题。');
    }
    this.preferences.enabled = enabled;
    try {
      await this.operations.applyAll(enabled);
      await this.operations.save(this.preferences);
    } catch (error) {
      // A partially applied theme must not survive as a successful preference.
      this.preferences.enabled = false;
      await this.operations.applyAll(false).catch(() => {});
      await this.operations.save(this.preferences).catch(() => {});
      throw error;
    }
  }

  async refreshRemoval(action) {
    const result = await this.operations.manage(action);
    this.uninstallStatus = result.status;
    if (result.status === 'error') throw new Error(result.error || result.message || '卸载操作失败');
  }

  dispatch(action, window) {
    if (!['enable', 'disable', 'replay', 'opening', 'auto-enter', 'uninstall', 'cancel-uninstall', 'status'].includes(action)) {
      return Promise.resolve(false);
    }
    return this.enqueue(async () => {
      // Opening the menu refreshes status; it must not erase an action failure.
      if (action !== 'status') this.error = '';
      try {
        if (action === 'enable' || action === 'disable') await this.setEnabled(action === 'enable');
        else if (action === 'replay') {
          if (this.preferences.enabled) await this.operations.replay(window);
        } else if (action === 'opening' || action === 'auto-enter') {
          const key = action === 'opening' ? 'openingOnLaunch' : 'autoEnterOnReady';
          const next = { ...this.preferences, [key]: !(this.preferences[key] !== false) };
          await this.operations.save(next);
          this.preferences = next;
        } else if (action === 'uninstall') {
          if (!await this.operations.confirmUninstall(window)) return false;
          // Disable first, while the runtime and resources are still present.
          await this.setEnabled(false);
          await this.refreshRemoval('Schedule');
        } else if (action === 'cancel-uninstall') {
          await this.refreshRemoval('Cancel');
        } else {
          await this.refreshRemoval('Status');
        }
        return true;
      } catch (error) {
        this.error = error.message || String(error);
        throw error;
      } finally {
        await this.operations.updateControls(this.snapshot());
      }
    });
  }
}

module.exports = { ThemeManager };
