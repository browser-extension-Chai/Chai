const STORAGE_KEY = "chai_rules";

export async function getRules() {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  return result[STORAGE_KEY] || [];
}

export async function saveRules(rules) {
  await chrome.storage.sync.set({ [STORAGE_KEY]: rules });
}

export async function addRule(rule) {
  const rules = await getRules();
  rules.push({ id: crypto.randomUUID(), ...rule });
  await saveRules(rules);
  return rules;
}

export async function updateRule(id, updates) {
  const rules = await getRules();
  const index = rules.findIndex(r => r.id === id);
  if (index !== -1) {
    rules[index] = { ...rules[index], ...updates };
    await saveRules(rules);
  }
  return rules;
}

export async function deleteRule(id) {
  const rules = await getRules();
  const filtered = rules.filter(r => r.id !== id);
  await saveRules(filtered);
  return filtered;
}
