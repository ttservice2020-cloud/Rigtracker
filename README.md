<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RigTracker Pro - Owner-Operator Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen">
    <!-- Header -->
    <header class="bg-slate-800 border-b border-slate-700 sticky top-0 z-50">
        <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
            <div class="flex items-center space-x-3">
                <div class="bg-amber-500 text-slate-950 font-black px-3 py-1.5 rounded text-lg tracking-wider">RT</div>
                <div>
                    <h1 class="text-xl font-bold tracking-tight text-white">RigTracker Pro</h1>
                    <p class="text-xs text-slate-400">Owner-Operator Settlement & Expense Ledger</p>
                </div>
            </div>
            <div class="flex space-x-2">
                <button onclick="exportData()" class="bg-slate-700 hover:bg-slate-600 text-xs px-3 py-2 rounded font-medium transition">Export JSON</button>
                <label class="bg-slate-700 hover:bg-slate-600 text-xs px-3 py-2 rounded font-medium cursor-pointer transition">
                    Import JSON <input type="file" id="importFile" onchange="importData(event)" class="hidden" accept=".json">
                </label>
            </div>
        </div>
    </header>

    <main class="max-w-7xl mx-auto px-4 py-6 space-y-6">
        <!-- Financial Metric Summary Cards -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div class="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-sm">
                <p class="text-xs font-medium text-slate-400 uppercase tracking-wider">YTD Gross Revenue</p>
                <p id="statGross" class="text-2xl font-black text-emerald-400 mt-1">$0.00</p>
            </div>
            <div class="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-sm">
                <p class="text-xs font-medium text-slate-400 uppercase tracking-wider">Total Loaded Miles</p>
                <p id="statMiles" class="text-2xl font-black text-blue-400 mt-1">0</p>
            </div>
            <div class="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-sm">
                <p class="text-xs font-medium text-slate-400 uppercase tracking-wider">Average Rate / Mile</p>
                <p id="statRpm" class="text-2xl font-black text-amber-400 mt-1">$0.00</p>
            </div>
            <div class="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-sm">
                <p class="text-xs font-medium text-slate-400 uppercase tracking-wider">Net Profit After Expenses</p>
                <p id="statNet" class="text-2xl font-black text-cyan-400 mt-1">$0.00</p>
            </div>
        </div>

        <!-- Smart Settlement Parser Tool -->
        <div class="bg-slate-800 p-6 rounded-xl border border-amber-500/30 shadow-md">
            <h2 class="text-lg font-bold mb-1 text-white flex items-center justify-between">
                <span>Quick Settlement Parser</span>
                <span class="text-xs bg-amber-500/20 text-amber-400 px-2.5 py-1 rounded-full font-normal">Paste Statement Text</span>
            </h2>
            <p class="text-xs text-slate-400 mb-4">Paste your email settlement text or numbers below, and click parse to instantly populate the form.</p>
            <div class="space-y-3">
                <textarea id="rawSettlementText" rows="3" placeholder="Paste settlement text here (e.g., Gross: 4500.00, Miles: 2100, Expenses: 1200)..." class="w-full bg-slate-900 border border-slate-700 rounded p-3 text-sm text-white focus:outline-none focus:border-amber-500"></textarea>
                <button type="button" onclick="parseSettlementText()" class="bg-slate-700 hover:bg-slate-600 text-amber-400 border border-amber-500/40 font-semibold px-4 py-2 rounded text-xs transition">Auto-Fill Form From Text</button>
            </div>
        </div>

        <!-- Add Settlement Form -->
        <div class="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-md">
            <h2 class="text-lg font-bold mb-4 text-white">Log Weekly Settlement</h2>
            <form id="settlementForm" onsubmit="addSettlement(event)" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                <div>
                    <label class="block text-xs font-medium text-slate-300 mb-1">Week Ending Date</label>
                    <input type="date" id="date" required class="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-white focus:outline-none focus:border-amber-500">
                </div>
                <div>
                    <label class="block text-xs font-medium text-slate-300 mb-1">Gross Revenue ($)</label>
                    <input type="number" step="0.01" id="gross" placeholder="0.00" required class="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-white focus:outline-none focus:border-amber-500">
                </div>
                <div>
                    <label class="block text-xs font-medium text-slate-300 mb-1">Loaded Miles</label>
                    <input type="number" id="miles" placeholder="0" required class="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-white focus:outline-none focus:border-amber-500">
                </div>
                <div>
                    <label class="block text-xs font-medium text-slate-300 mb-1">Total Expenses ($)</label>
                    <input type="number" step="0.01" id="expenses" placeholder="0.00" required class="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-white focus:outline-none focus:border-amber-500">
                </div>
                <div class="flex items-end">
                    <button type="submit" class="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold p-2 rounded text-sm transition">Save Settlement</button>
                </div>
            </form>
        </div>

        <!-- Charts Section -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div class="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-sm">
                <h3 class="text-sm font-bold text-slate-300 mb-4">Gross Revenue vs. Expenses</h3>
                <div class="relative h-64">
                    <canvas id="financeChart"></canvas>
                </div>
            </div>
            <div class="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-sm">
                <h3 class="text-sm font-bold text-slate-300 mb-4">Weekly Mileage Trend</h3>
                <div class="relative h-64">
                    <canvas id="mileageChart"></canvas>
                </div>
            </div>
        </div>

        <!-- Settlement History Table -->
        <div class="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden shadow-md">
            <div class="p-6 border-b border-slate-700 flex justify-between items-center">
                <h3 class="text-lg font-bold text-white">Settlement History</h3>
                <span id="recordCount" class="text-xs bg-slate-700 text-slate-300 px-2.5 py-1 rounded-full">0 entries</span>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-left border-collapse text-sm">
                    <thead>
                        <tr class="bg-slate-900/50 text-slate-400 border-b border-slate-700 text-xs uppercase tracking-wider">
                            <th class="p-4">Week Ending</th>
                            <th class="p-4">Gross Revenue</th>
                            <th class="p-4">Loaded Miles</th>
                            <th class="p-4">Rate / Mile</th>
                            <th class="p-4">Expenses</th>
                            <th class="p-4">Net Payout</th>
                            <th class="p-4 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody id="settlementTableBody" class="divide-y divide-slate-700">
                        <!-- Dynamic rows injected here -->
                    </tbody>
                </table>
            </div>
        </div>
    </main>

    <script>
        let settlements = JSON.parse(localStorage.getItem('rigtracker_settlements')) || [];
        let financeChartInstance = null;
        let mileageChartInstance = null;

        function saveToStorage() {
            localStorage.setItem('rigtracker_settlements', JSON.stringify(settlements));
        }

        function parseSettlementText() {
            const text = document.getElementById('rawSettlementText').value;
            if (!text) {
                alert("Please paste some settlement text first.");
                return;
            }

            // Simple regex extractors for numbers and currency
            const numbers = text.match(/[\d,]+\.\d{2}|\d+/g);
            if (numbers && numbers.length > 0) {
                // Clean numbers and populate fields based on typical patterns
                const cleanNums = numbers.map(n => parseFloat(n.replace(/,/g, '')));
                
                // Look for largest figure as gross, smaller figures as miles/expenses if possible
                if (cleanNums.length >= 1) {
                    document.getElementById('gross').value = cleanNums[0];
                }
                if (cleanNums.length >= 2) {
                    document.getElementById('miles').value = cleanNums[1];
                }
                if (cleanNums.length >= 3) {
                    document.getElementById('expenses').value = cleanNums[2];
                }
                
                // Default to today if no date found
                document.getElementById('date').value = new Date().toISOString().split('T')[0];
                alert("Parsed successfully! Check the form values and click Save Settlement.");
            } else {
                alert("Could not automatically detect numbers. Please enter manually.");
            }
        }

        function addSettlement(e) {
            e.preventDefault();
            const date = document.getElementById('date').value;
            const gross = parseFloat(document.getElementById('gross').value) || 0;
            const miles = parseInt(document.getElementById('miles').value) || 0;
            const expenses = parseFloat(document.getElementById('expenses').value) || 0;

            const newItem = {
                id: Date.now(),
                date,
                gross,
                miles,
                expenses
            };

            settlements.push(newItem);
            settlements.sort((a, b) => new Date(a.date) - new Date(b.date));
            saveToStorage();
            renderApp();
            document.getElementById('settlementForm').reset();
            document.getElementById('rawSettlementText').value = '';
        }

        function deleteSettlement(id) {
            settlements = settlements.filter(item => item.id !== id);
            saveToStorage();
            renderApp();
        }

        function renderStats() {
            const totalGross = settlements.reduce((sum, item) => sum + item.gross, 0);
            const totalMiles = settlements.reduce((sum, item) => sum + item.miles, 0);
            const totalExpenses = settlements.reduce((sum, item) => sum + item.expenses, 0);
            const netProfit = totalGross - totalExpenses;
            const avgRpm = totalMiles > 0 ? totalGross / totalMiles : 0;

            document.getElementById('statGross').innerText = `$${totalGross.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            document.getElementById('statMiles').innerText = totalMiles.toLocaleString('en-US');
            document.getElementById('statRpm').innerText = `$${avgRpm.toFixed(2)}`;
            document.getElementById('statNet').innerText = `$${netProfit.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            document.getElementById('recordCount').innerText = `${settlements.length} entries`;
        }

        function renderTable() {
            const tbody = document.getElementById('settlementTableBody');
            tbody.innerHTML = '';

            if (settlements.length === 0) {
                tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-slate-500">No settlement records logged yet. Add your first entry above.</td></tr>`;
                return;
            }

            const sortedForTable = [...settlements].reverse();
            sortedForTable.forEach(item => {
                const rpm = item.miles > 0 ? (item.gross / item.miles).toFixed(2) : '0.00';
                const net = item.gross - item.expenses;

                const tr = document.createElement('tr');
                tr.className = 'hover:bg-slate-700/50 transition';
                tr.innerHTML = `
                    <td class="p-4 font-medium text-white">${item.date}</td>
                    <td class="p-4 text-emerald-400 font-semibold">$${item.gross.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                    <td class="p-4 text-slate-300">${item.miles.toLocaleString('en-US')} mi</td>
                    <td class="p-4 text-amber-400 font-medium">$${rpm}</td>
                    <td class="p-4 text-rose-400">$${item.expenses.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                    <td class="p-4 text-cyan-400 font-semibold">$${net.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                    <td class="p-4 text-right">
                        <button onclick="deleteSettlement(${item.id})" class="text-slate-400 hover:text-rose-400 text-xs font-medium px-2 py-1 rounded bg-slate-700/50 hover:bg-slate-700 transition">Delete</button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }

        function renderCharts() {
            const labels = settlements.map(item => item.date);
            const grossData = settlements.map(item => item.gross);
            const expenseData = settlements.map(item => item.expenses);
            const mileageData = settlements.map(item => item.miles);

            const ctxFinance = document.getElementById('financeChart').getContext('2d');
            if (financeChartInstance) financeChartInstance.destroy();
            financeChartInstance = new Chart(ctxFinance, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [
                        { label: 'Gross ($)', data: grossData, backgroundColor: '#34d399', borderRadius: 4 },
                        { label: 'Expenses ($)', data: expenseData, backgroundColor: '#fb7185', borderRadius: 4 }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11 } } } },
                    scales: {
                        x: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' } },
                        y: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' } }
                    }
                }
            });

            const ctxMileage = document.getElementById('mileageChart').getContext('2d');
            if (mileageChartInstance) mileageChartInstance.destroy();
            mileageChartInstance = new Chart(ctxMileage, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Loaded Miles',
                        data: mileageData,
                        borderColor: '#60a5fa',
                        backgroundColor: 'rgba(96, 165, 250, 0.1)',
                        fill: true,
                        tension: 0.2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11 } } } },
                    scales: {
                        x: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' } },
                        y: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' } }
                    }
                }
            });
        }

        function exportData() {
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(settlements, null, 2));
            const downloadAnchor = document.createElement('a');
            downloadAnchor.setAttribute("href", dataStr);
            downloadAnchor.setAttribute("download", "rigtracker_backup.json");
            document.body.appendChild(downloadAnchor);
            downloadAnchor.click();
            downloadAnchor.remove();
        }

        function importData(event) {
            const fileReader = new FileReader();
            if (event.target.files[0]) {
                fileReader.readAsText(event.target.files[0], "UTF-8");
                fileReader.onload = function(e) {
                    try {
                        const imported = JSON.parse(e.target.result);
                        if (Array.isArray(imported)) {
                            settlements = imported;
                            saveToStorage();
                            renderApp();
                            alert("Data imported successfully!");
                        } else {
                            alert("Invalid backup file format.");
                        }
                    } catch (err) {
                        alert("Error parsing JSON file.");
                    }
                }
            }
        }

        function renderApp() {
            renderStats();
            renderTable();
            renderCharts();
        }

        renderApp();
    </script>
</body>
</html>
