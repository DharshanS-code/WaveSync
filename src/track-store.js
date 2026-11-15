// File references stay local. Queue positions are never network track identities.
export class TrackStore {
  constructor() { this.items = []; this.revision = 0; this.currentId = null; }
  append(files) {
    const selected = Array.from(files || []);
    if (this.items.length + selected.length > 100) throw new Error('A queue can contain at most 100 tracks.');
    const additions = selected.map(file => {
      if (!file.size || file.size > 32 * 1024 * 1024) throw new Error(`${file.name}: choose a file no larger than 32 MiB.`);
      return { id: crypto.randomUUID(), file, name: file.name.replace(/\.[^.]+$/, '').trim().slice(0,200) || 'Untitled track',
        mime: file.type || 'application/octet-stream', size: file.size, duration: null };
    });
    this.items.push(...additions); this.revision++;
    return additions;
  }
  get(id) { return this.items.find(item => item.id === id); }
  remove(id) {
    const index = this.items.findIndex(item => item.id === id);
    if (index < 0) return false;
    this.items.splice(index, 1); this.revision++;
    if (this.currentId === id) this.currentId = null;
    return true;
  }
  move(id, target, drop = false) {
    const index = this.items.findIndex(item => item.id === id);
    const destination = drop ? this.items.findIndex(item => item.id === target) : index + (target === 'up' ? -1 : 1);
    if (index < 0 || destination < 0 || destination >= this.items.length || index === destination) return false;
    const [item] = this.items.splice(index,1); this.items.splice(destination,0,item); this.revision++;
    return true;
  }
  adjacent(direction, { shuffle = false, repeat = 'off', ended = false } = {}) {
    if (!this.items.length) return null;
    if (ended && repeat === 'one') return this.currentId;
    const index = this.items.findIndex(item => item.id === this.currentId);
    if (shuffle && this.items.length > 1) {
      const others = this.items.filter(item => item.id !== this.currentId);
      const value = new Uint32Array(1); crypto.getRandomValues(value);
      return others[value[0] % others.length].id;
    }
    const next = index + direction;
    if (next >= 0 && next < this.items.length) return this.items[next].id;
    if (repeat === 'all') return this.items[(next + this.items.length) % this.items.length].id;
    return null;
  }
  clear() { this.items = []; this.currentId = null; this.revision++; }
}

export class BufferCache {
  constructor(maxBytes = 192 * 1024 * 1024) { this.maxBytes = maxBytes; this.buffers = new Map(); }
  get bytes() { return [...this.buffers.values()].reduce((sum, b) => sum + b.length * b.numberOfChannels * 4, 0); }
  get(id) { return this.buffers.get(id); }
  set(id, buffer, protectedId = null) {
    this.buffers.delete(id);
    this.buffers.set(id, buffer);
    while (this.buffers.size > 2 || this.bytes > this.maxBytes) {
      const candidate = [...this.buffers.keys()].find(key => key !== protectedId && key !== id);
      if (!candidate) { this.buffers.delete(id); throw new Error('Audio cache memory budget exceeded.'); }
      this.buffers.delete(candidate);
    }
  }
  clear() { this.buffers.clear(); }
}
