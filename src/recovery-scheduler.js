(function initRecoveryScheduler(root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";

  const IDLE_DELAY_MS = 1000;
  const MAXIMUM_DELAY_MS = 10000;

  function requireDocumentId(id) {
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError("document id must be a non-empty string");
    }
    return id;
  }

  function requireRevision(revision) {
    if (!Number.isSafeInteger(revision)) {
      throw new TypeError("revision must be a safe integer");
    }
    if (revision < 0) throw new RangeError("revision must be non-negative");
    return revision;
  }

  function normalizeError(reason) {
    if (reason instanceof Error) return reason;
    return new Error(String(reason));
  }

  function defaultClock() {
    return {
      setTimeout(callback, delay) {
        return setTimeout(callback, delay);
      },
      clearTimeout(timer) {
        clearTimeout(timer);
      },
    };
  }

  class RecoveryScheduler {
    constructor({ clock = defaultClock(), write, onStatus } = {}) {
      if (typeof write !== "function") throw new TypeError("write must be a function");
      if (!clock || typeof clock.setTimeout !== "function" || typeof clock.clearTimeout !== "function") {
        throw new TypeError("clock must provide setTimeout and clearTimeout");
      }
      if (onStatus !== undefined && typeof onStatus !== "function") {
        throw new TypeError("onStatus must be a function");
      }

      this._clock = clock;
      this._write = write;
      this._onStatus = onStatus || null;
      this._entries = new Map();
    }

    changed(id, revision) {
      requireDocumentId(id);
      requireRevision(revision);

      const entry = this._entry(id);
      if (entry.forgotten) throw new Error(`document ${id} is being forgotten`);
      if (revision <= entry.latestRevision) return false;

      entry.latestRevision = revision;
      entry.failed = null;
      this._setStatus(entry, "pending");
      this._schedule(entry);
      return true;
    }

    flush(id, revision) {
      requireDocumentId(id);
      if (revision !== undefined) requireRevision(revision);

      let entry = this._entries.get(id);
      if (!entry) {
        if (revision === undefined) return Promise.resolve();
        entry = this._entry(id);
      }
      if (entry.forgotten) {
        return Promise.reject(new Error(`recovery was forgotten for document ${id}`));
      }

      if (revision !== undefined && revision > entry.latestRevision) {
        entry.latestRevision = revision;
        entry.failed = null;
        this._setStatus(entry, "pending");
      }

      const targetRevision = entry.latestRevision;
      if (targetRevision < 0 || targetRevision <= entry.persistedRevision) {
        this._clearTimers(entry);
        return Promise.resolve();
      }
      return this._requestFlush(entry, targetRevision);
    }

    async flushAll() {
      const entries = [...this._entries.values()].filter((entry) => !entry.forgotten);
      const results = await Promise.allSettled(entries.map((entry) => this.flush(entry.id, entry.latestRevision)));
      const failures = [];

      for (let index = 0; index < results.length; index += 1) {
        if (results[index].status === "rejected") {
          failures.push({ id: entries[index].id, error: normalizeError(results[index].reason) });
        }
      }

      if (failures.length > 0) {
        const ids = failures.map((failure) => failure.id);
        const message = `Failed to flush recovery for document IDs: ${ids.join(", ")}`;
        const error = typeof AggregateError === "function"
          ? new AggregateError(failures.map((failure) => failure.error), message)
          : new Error(message);
        error.ids = ids;
        throw error;
      }
    }

    forget(id) {
      requireDocumentId(id);
      const entry = this._entries.get(id);
      if (!entry || entry.forgotten) return false;

      entry.forgotten = true;
      this._clearTimers(entry);
      this._rejectWaiters(entry, new Error(`recovery was forgotten for document ${id}`));
      if (!entry.inFlight) this._entries.delete(id);
      return true;
    }

    retry(id) {
      requireDocumentId(id);
      const entry = this._entries.get(id);
      if (!entry) return Promise.resolve();
      if (entry.forgotten) {
        return Promise.reject(new Error(`recovery was forgotten for document ${id}`));
      }

      entry.failed = null;
      if (entry.latestRevision <= entry.persistedRevision) {
        this._setStatus(entry, "clean");
        return Promise.resolve();
      }
      this._setStatus(entry, "pending");
      return this._requestFlush(entry, entry.latestRevision);
    }

    _entry(id) {
      let entry = this._entries.get(id);
      if (entry) return entry;

      entry = {
        id,
        latestRevision: -1,
        persistedRevision: -1,
        idleTimer: null,
        maximumTimer: null,
        inFlight: null,
        failed: null,
        forgotten: false,
        status: "clean",
        waiters: new Set(),
      };
      this._entries.set(id, entry);
      return entry;
    }

    _schedule(entry) {
      if (entry.idleTimer !== null) this._clock.clearTimeout(entry.idleTimer);
      entry.idleTimer = this._clock.setTimeout(() => {
        entry.idleTimer = null;
        this._timerFlush(entry);
      }, IDLE_DELAY_MS);

      if (entry.maximumTimer === null) {
        entry.maximumTimer = this._clock.setTimeout(() => {
          entry.maximumTimer = null;
          this._timerFlush(entry);
        }, MAXIMUM_DELAY_MS);
      }
    }

    _timerFlush(entry) {
      if (!this._isActive(entry)) return;
      if (entry.failed) {
        entry.failed = null;
        this._setStatus(entry, "pending");
      }
      this._clearTimers(entry);
      if (entry.latestRevision > entry.persistedRevision) this._start(entry);
    }

    _requestFlush(entry, targetRevision) {
      this._clearTimers(entry);
      if (targetRevision <= entry.persistedRevision) return Promise.resolve();
      if (entry.failed) return Promise.reject(entry.failed);

      const promise = new Promise((resolve, reject) => {
        entry.waiters.add({ revision: targetRevision, resolve, reject });
      });
      this._start(entry);
      return promise;
    }

    _start(entry) {
      if (entry.inFlight || !this._isActive(entry)) return;

      let resolveOperation;
      let rejectOperation;
      const operation = new Promise((resolve, reject) => {
        resolveOperation = resolve;
        rejectOperation = reject;
      });
      entry.inFlight = operation;
      this._run(entry).then(resolveOperation, rejectOperation);
      operation.then(
        () => this._finish(entry, operation),
        () => this._finish(entry, operation),
      );
    }

    async _run(entry) {
      while (this._isActive(entry) && entry.latestRevision > entry.persistedRevision) {
        const revision = entry.latestRevision;
        this._clearTimers(entry);
        this._setStatus(entry, "writing");

        try {
          await this._write(entry.id, revision);
        } catch (reason) {
          if (!this._isActive(entry)) return;
          const error = normalizeError(reason);
          entry.failed = error;
          this._rejectWaiters(entry, error);
          this._setStatus(entry, "failed", error);
          if (this._isActive(entry)
              && entry.latestRevision > revision
              && entry.idleTimer === null
              && entry.maximumTimer === null) {
            this._schedule(entry);
          }
          throw error;
        }

        if (!this._isActive(entry)) return;
        entry.persistedRevision = Math.max(entry.persistedRevision, revision);
        this._resolveWaiters(entry);

        if (entry.latestRevision > entry.persistedRevision) {
          this._setStatus(entry, "pending");
        }
      }

      if (this._isActive(entry)) this._setStatus(entry, "clean");
    }

    _finish(entry, operation) {
      if (entry.inFlight !== operation) return;
      entry.inFlight = null;
      if (entry.forgotten && this._entries.get(entry.id) === entry) {
        this._entries.delete(entry.id);
      } else if (this._isActive(entry) && !entry.failed && entry.latestRevision > entry.persistedRevision) {
        this._start(entry);
      }
    }

    _resolveWaiters(entry) {
      for (const waiter of entry.waiters) {
        if (waiter.revision <= entry.persistedRevision) {
          entry.waiters.delete(waiter);
          waiter.resolve();
        }
      }
    }

    _rejectWaiters(entry, error) {
      for (const waiter of entry.waiters) {
        entry.waiters.delete(waiter);
        waiter.reject(error);
      }
    }

    _clearTimers(entry) {
      if (entry.idleTimer !== null) {
        this._clock.clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      if (entry.maximumTimer !== null) {
        this._clock.clearTimeout(entry.maximumTimer);
        entry.maximumTimer = null;
      }
    }

    _isActive(entry) {
      return !entry.forgotten && this._entries.get(entry.id) === entry;
    }

    _setStatus(entry, status, error) {
      if (!this._isActive(entry) || entry.status === status) return;
      entry.status = status;
      if (!this._onStatus) return;
      try {
        this._onStatus(entry.id, status, error);
      } catch (_) {
        // Status observers must not interfere with recovery durability.
      }
    }
  }

  return { RecoveryScheduler };
});
