const CATEGORIES = ["Food", "Housing", "Transport", "Utilities", "Health", "Shopping", "Entertainment", "Other"];
const LEGACY_STORAGE_KEY = "pennywiseBudget";
const $ = id => document.getElementById(id);
const currency = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2
});

let data = { income: 0, target: 0, expenses: [] };
let authMode = "login";
let saveQueue = Promise.resolve();

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function showMessage(message, isError = false) {
  const element = $("appMessage");
  element.textContent = message;
  element.classList.toggle("error", isError);
  element.hidden = false;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "The request could not be completed.");
    error.status = response.status;
    throw error;
  }
  return result;
}

function showAuthMessage(message, isError = false) {
  const element = $("authMessage");
  element.textContent = message;
  element.classList.toggle("error", isError);
  element.hidden = false;
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  setPasswordVisibility("authPassword", "passwordToggle", false);
  setPasswordVisibility("confirmPassword", "confirmPasswordToggle", false);
  $("authTitle").textContent = registering ? "Create your account." : "Welcome back.";
  $("authSubmit").textContent = registering ? "Create account" : "Sign in";
  $("authSwitchPrompt").textContent = registering ? "Already have an account?" : "New to Pennywise?";
  $("authSwitch").textContent = registering ? "Sign in" : "Create an account";
  $("confirmPasswordField").hidden = !registering;
  $("confirmPassword").required = registering;
  $("authPassword").autocomplete = registering ? "new-password" : "current-password";
  $("authMessage").hidden = true;
}

function setPasswordVisibility(inputId, buttonId, visible) {
  const input = $(inputId);
  const button = $(buttonId);
  input.type = visible ? "text" : "password";
  button.textContent = visible ? "Hide" : "Show";
  button.setAttribute("aria-label", `${visible ? "Hide" : "Show"} ${inputId === "confirmPassword" ? "confirm password" : "password"}`);
  button.setAttribute("aria-pressed", String(visible));
}

function showAccount(email) {
  $("authSection").hidden = true;
  $("accountContent").hidden = false;
  const dot = document.createElement("span");
  dot.className = "privacy-dot";
  dot.setAttribute("aria-hidden", "true");
  $("accountEmail").replaceChildren(dot, document.createTextNode(email));
  $("logoutButton").hidden = false;
}

function showSignIn() {
  $("accountContent").hidden = true;
  $("authSection").hidden = false;
  $("logoutButton").hidden = true;
  $("accountEmail").replaceChildren();
}

function readLegacyBudget() {
  const saved = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!saved) return null;

  const parsed = JSON.parse(saved);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.expenses)) {
    throw new Error("Your existing on-device budget could not be read. It has not been changed.");
  }
  return {
    income: Number.isFinite(parsed.income) && parsed.income >= 0 ? parsed.income : 0,
    target: Number.isFinite(parsed.target) && parsed.target >= 0 ? parsed.target : 0,
    expenses: parsed.expenses.filter(expense =>
      expense &&
      typeof expense.id === "string" &&
      typeof expense.description === "string" &&
      Number.isFinite(expense.amount) &&
      expense.amount > 0 &&
      CATEGORIES.includes(expense.category) &&
      typeof expense.date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(expense.date)
    )
  };
}

async function loadBudget() {
  const saved = await apiRequest("/api/budget");
  if (!saved || typeof saved !== "object" || !Array.isArray(saved.expenses)) {
    throw new Error("The saved budget data has an unexpected format.");
  }
  data.income = Number.isFinite(saved.income) && saved.income >= 0 ? saved.income : 0;
  data.target = Number.isFinite(saved.target) && saved.target >= 0 ? saved.target : 0;
  data.expenses = saved.expenses.filter(expense =>
    expense &&
    typeof expense.id === "string" &&
    typeof expense.description === "string" &&
    Number.isFinite(expense.amount) &&
    expense.amount > 0 &&
    CATEGORIES.includes(expense.category) &&
    typeof expense.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(expense.date)
  );
  $("income").value = String(data.income);
  $("target").value = String(data.target);
}

function persistData() {
  const snapshot = JSON.stringify(data);
  const operation = saveQueue.catch(() => {}).then(() =>
    apiRequest("/api/budget", { method: "PUT", body: snapshot })
  );
  saveQueue = operation;
  return operation;
}

function getSelectedMonth() {
  return $("month").value;
}

function getMonthlyExpenses() {
  const month = getSelectedMonth();
  return data.expenses
    .filter(expense => expense.date.startsWith(month))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

function formatDate(dateString) {
  return new Date(`${dateString}T00:00:00`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric"
  });
}

function renderSummary(expenses) {
  const spent = expenses.reduce((total, expense) => total + expense.amount, 0);
  const remaining = data.income - spent;
  const available = remaining - data.target;
  const ratio = data.income > 0 ? spent / data.income : 0;
  const progress = Math.min(100, Math.round(ratio * 100));

  $("incomeSummary").textContent = currency.format(data.income);
  $("spentSummary").textContent = currency.format(spent);
  $("targetSummary").textContent = currency.format(data.target);
  $("available").textContent = currency.format(available);
  $("availableHint").textContent = available < 0
    ? `${currency.format(Math.abs(available))} over your plan`
    : "After your savings target";
  $("spentHint").textContent = expenses.length === 1 ? "1 expense logged" : `${expenses.length} expenses logged`;
  $("savingsHint").textContent = data.target > 0
    ? `${currency.format(Math.max(0, remaining))} left after expenses`
    : "Set a goal that feels right";

  $("progressPercent").textContent = data.income > 0 ? `${Math.round(ratio * 100)}%` : "0%";
  $("progressBar").style.width = `${progress}%`;
  $("progressTrack").classList.toggle("over-budget", ratio > 1);
  $("progressTrack").setAttribute("aria-valuenow", String(progress));
  $("progressHint").textContent = data.income === 0
    ? "Add your income to see your spending progress."
    : ratio > 1
      ? "You’ve spent more than your planned income."
      : `${currency.format(Math.max(0, data.income - spent))} of your income remains.`;
}

function renderCategories(expenses) {
  const totals = new Map();
  expenses.forEach(expense => {
    totals.set(expense.category, (totals.get(expense.category) || 0) + expense.amount);
  });

  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const container = $("categoryBreakdown");
  container.replaceChildren();

  if (sorted.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Your category breakdown will show up here.";
    container.append(empty);
    return;
  }

  const maxAmount = sorted[0][1];
  sorted.forEach(([category, amount]) => {
    const item = document.createElement("div");
    item.className = "category-item";

    const details = document.createElement("div");
    details.className = "category-details";
    const name = document.createElement("span");
    name.className = "category-name";
    name.textContent = category;
    const formattedAmount = document.createElement("span");
    formattedAmount.className = "category-amount";
    formattedAmount.textContent = currency.format(amount);
    details.append(name, formattedAmount);

    const track = document.createElement("div");
    track.className = "category-track";
    const bar = document.createElement("span");
    bar.style.width = `${Math.max(4, (amount / maxAmount) * 100)}%`;
    track.append(bar);
    item.append(details, track);
    container.append(item);
  });
}

function getCategoryIcon(category) {
  const icons = {
    Food: "F",
    Housing: "H",
    Transport: "T",
    Utilities: "U",
    Health: "+",
    Shopping: "S",
    Entertainment: "E",
    Other: "·"
  };
  return icons[category] || "·";
}

function renderTransactions(expenses) {
  const list = $("transactionList");
  list.replaceChildren();
  $("expenseCount").textContent = expenses.length === 1 ? "1 item" : `${expenses.length} items`;

  if (expenses.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "No expenses for this month yet. Add one above to get started.";
    list.append(empty);
    return;
  }

  expenses.forEach(expense => {
    const item = document.createElement("li");
    item.className = "transaction-item";

    const icon = document.createElement("span");
    icon.className = "transaction-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = getCategoryIcon(expense.category);

    const info = document.createElement("div");
    info.className = "transaction-info";
    const title = document.createElement("p");
    title.className = "transaction-title";
    title.textContent = expense.description;
    const meta = document.createElement("p");
    meta.className = "transaction-meta";
    meta.textContent = `${expense.category} · ${formatDate(expense.date)}`;
    info.append(title, meta);

    const amount = document.createElement("span");
    amount.className = "transaction-amount";
    amount.textContent = `−${currency.format(expense.amount)}`;

    const remove = document.createElement("button");
    remove.className = "delete-button";
    remove.type = "button";
    remove.dataset.expenseId = expense.id;
    remove.setAttribute("aria-label", `Delete ${expense.description}`);
    remove.title = "Delete expense";
    remove.textContent = "×";

    item.append(icon, info, amount, remove);
    list.append(item);
  });
}

function render() {
  const expenses = getMonthlyExpenses();
  renderSummary(expenses);
  renderCategories(expenses);
  renderTransactions(expenses);
}

async function handlePlanSubmit(event) {
  event.preventDefault();
  const income = Number($("income").value);
  const target = Number($("target").value);
  if (!Number.isFinite(income) || !Number.isFinite(target) || income < 0 || target < 0) {
    showMessage("Enter valid amounts of zero or more for your monthly plan.", true);
    return;
  }

  const previous = { income: data.income, target: data.target };
  data.income = income;
  data.target = target;
  try {
    await persistData();
    showMessage("Your monthly plan has been saved.");
  } catch (error) {
    data.income = previous.income;
    data.target = previous.target;
    $("income").value = String(data.income);
    $("target").value = String(data.target);
    showMessage(`Your monthly plan could not be saved: ${error.message}`, true);
  }
  render();
}

async function handleExpenseSubmit(event) {
  event.preventDefault();
  const description = $("description").value.trim();
  const amount = Number($("amount").value);
  const category = $("category").value;
  const date = $("date").value;

  if (!description || !Number.isFinite(amount) || amount <= 0 || !CATEGORIES.includes(category) || !date) {
    showMessage("Enter an expense description, a positive amount, a category, and a date.", true);
    return;
  }

  const expense = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    description,
    amount,
    category,
    date
  };
  data.expenses.push(expense);
  let saved = false;
  try {
    await persistData();
    saved = true;
    showMessage("Expense added.");
  } catch (error) {
    data.expenses = data.expenses.filter(item => item.id !== expense.id);
    showMessage(`Expense could not be saved: ${error.message}`, true);
  }
  if (saved) {
    $("expenseForm").reset();
    $("date").value = localDateString();
    $("month").value = date.slice(0, 7);
  }
  render();
}

async function handleTransactionClick(event) {
  const button = event.target.closest("button[data-expense-id]");
  if (!button) return;
  const expense = data.expenses.find(item => item.id === button.dataset.expenseId);
  if (!expense) return;

  const previousExpenses = data.expenses;
  data.expenses = data.expenses.filter(item => item.id !== expense.id);
  try {
    await persistData();
    showMessage("Expense deleted.");
  } catch (error) {
    data.expenses = previousExpenses;
    showMessage(`Expense could not be deleted: ${error.message}`, true);
  }
  render();
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  if (authMode === "register" && password !== $("confirmPassword").value) {
    showAuthMessage("The passwords do not match.", true);
    return;
  }

  $("authSubmit").disabled = true;
  try {
    const path = authMode === "register" ? "/api/register" : "/api/login";
    const body = { email, password };
    const legacyBudget = authMode === "register" ? readLegacyBudget() : null;
    if (legacyBudget) body.budget = legacyBudget;
    const result = await apiRequest(path, {
      method: "POST",
      body: JSON.stringify(body)
    });
    if (legacyBudget) {
      try {
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch {
        showMessage("Account created, but the old on-device budget copy could not be removed.", true);
      }
    }
    await loadBudget();
    showAccount(result.user.email);
    render();
  } catch (error) {
    showAuthMessage(error.message, true);
  } finally {
    $("authSubmit").disabled = false;
  }
}

async function handleLogout() {
  $("logoutButton").disabled = true;
  try {
    await apiRequest("/api/logout", { method: "POST", body: "{}" });
    data = { income: 0, target: 0, expenses: [] };
    $("income").value = "";
    $("target").value = "";
    showSignIn();
    setAuthMode("login");
  } catch (error) {
    showMessage(`Could not sign out: ${error.message}`, true);
  } finally {
    $("logoutButton").disabled = false;
  }
}

async function initialize() {
  $("month").value = localDateString().slice(0, 7);
  $("date").value = localDateString();
  $("planForm").addEventListener("submit", handlePlanSubmit);
  $("expenseForm").addEventListener("submit", handleExpenseSubmit);
  $("month").addEventListener("change", render);
  $("transactionList").addEventListener("click", handleTransactionClick);
  $("authForm").addEventListener("submit", handleAuthSubmit);
  $("passwordToggle").addEventListener("click", () => {
    setPasswordVisibility("authPassword", "passwordToggle", $("authPassword").type === "password");
  });
  $("confirmPasswordToggle").addEventListener("click", () => {
    setPasswordVisibility("confirmPassword", "confirmPasswordToggle", $("confirmPassword").type === "password");
  });
  $("authSwitch").addEventListener("click", () => {
    setAuthMode(authMode === "login" ? "register" : "login");
  });
  $("logoutButton").addEventListener("click", handleLogout);

  try {
    const result = await apiRequest("/api/session");
    if (!result.user) {
      showSignIn();
      return;
    }
    await loadBudget();
    showAccount(result.user.email);
    render();
  } catch (error) {
    showSignIn();
    if (error.status !== 401) {
      showAuthMessage(`Could not connect to your account: ${error.message}`, true);
    }
  }
}

document.addEventListener("DOMContentLoaded", initialize);
