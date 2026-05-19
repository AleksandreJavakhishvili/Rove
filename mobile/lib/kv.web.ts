const memory = new Map<string, string>();

function backend(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  return {
    getItem: (k) => (memory.has(k) ? (memory.get(k) as string) : null),
    setItem: (k, v) => {
      memory.set(k, v);
    },
    removeItem: (k) => {
      memory.delete(k);
    },
  };
}

const KV = {
  async getItemAsync(key: string): Promise<string | null> {
    return backend().getItem(key);
  },
  async setItemAsync(key: string, value: string): Promise<void> {
    backend().setItem(key, value);
  },
  async removeItemAsync(key: string): Promise<void> {
    backend().removeItem(key);
  },
};

export default KV;
