<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">
    <title>✨ DOT BINGO · ዶት ቢንጎ ✨</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            user-select: none;
            -webkit-tap-highlight-color: transparent;
        }

        body {
            min-height: 100vh;
            background: #1a2a2f;
            background-image: radial-gradient(circle at 25% 40%, rgba(40, 70, 55, 0.6) 2%, transparent 2.5%),
                              radial-gradient(circle at 70% 85%, rgba(30, 60, 45, 0.5) 1.8%, transparent 2%);
            background-size: 55px 55px, 70px 70px;
            font-family: 'Courier New', 'Segoe UI', 'Inter', 'Courier', monospace;
            padding: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .page {
            max-width: 650px;
            width: 100%;
            margin: 0 auto;
            background: #fef7e0;
            background-image: linear-gradient(145deg, #fff6e5 0%, #f8ecd8 100%);
            border-radius: 32px;
            padding: 16px 18px 24px;
            box-shadow: 0 20px 35px rgba(0, 0, 0, 0.5), inset 0 1px 3px rgba(255, 248, 210, 0.9);
            border: 1px solid #e0bc7c;
        }

        .hidden {
            display: none !important;
        }

        /* RETRO BINGO CARD */
        .card-container {
            margin: 16px 0 12px;
            display: flex;
            justify-content: center;
            background: #e9dbc8;
            border-radius: 24px;
            padding: 12px 6px;
            box-shadow: inset 0 0 0 2px #f9efdf, 0 10px 18px rgba(0, 0, 0, 0.2);
            overflow-x: auto;
        }

        .card-container table {
            border-collapse: separate;
            border-spacing: 6px;
            margin: 0 auto;
        }

        .card-container thead tr th {
            font-family: 'Impact', 'Courier New', monospace;
            font-size: 1.6rem;
            font-weight: 800;
            letter-spacing: 1px;
            background: #c2410c;
            background: linear-gradient(145deg, #b8511a, #9b2e0b);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            text-shadow: 2px 2px 0 #fccf7c;
            padding: 6px 0;
            text-align: center;
            width: 60px;
        }

        .card-container td {
            width: 58px;
            height: 58px;
            background: #fffaf0;
            border-radius: 16px;
            text-align: center;
            vertical-align: middle;
            font-weight: 800;
            font-size: 1.3rem;
            font-family: 'Courier New', monospace;
            color: #2c1c0c;
            box-shadow: inset 0 1px 3px rgba(90, 50, 20, 0.2), 0 4px 8px rgba(0, 0, 0, 0.15);
            border: 2px solid #e0b070;
            transition: all 0.1s ease;
            cursor: pointer;
        }

        .card-container td.free {
            background: #e9d5b5;
            color: #b34e1a;
            font-size: 1.6rem;
            text-shadow: 0 0 2px #ffdd99;
            border-color: #c2812a;
        }

        .card-container td.marked {
            background: radial-gradient(ellipse at 30% 35%, #f3bc5c, #e5952b);
            color: #2c1500;
            box-shadow: 0 0 0 2px #ffdfaa, inset 0 0 10px #ffd58c;
            border-color: #f5b642;
            transform: scale(0.97);
            font-weight: 900;
        }

        .last-call-area {
            background: #0b0a07;
            border-radius: 40px;
            padding: 12px 16px;
            margin: 8px 0 12px;
            text-align: center;
            box-shadow: inset 0 0 0 2px #6b4e2c, 0 8px 14px rgba(0,0,0,0.4);
            border: 1px solid #e5b46b;
        }
        .last-call-label {
            font-size: 0.8rem;
            letter-spacing: 2px;
            font-weight: bold;
            color: #f7d88c;
            text-transform: uppercase;
            background: #2a241b;
            display: inline-block;
            padding: 3px 12px;
            border-radius: 30px;
        }
        .last-call-number {
            font-size: 2.8rem;
            font-weight: 800;
            font-family: monospace;
            color: #ffdd99;
            text-shadow: 0 0 6px #ffaa33;
            letter-spacing: 4px;
            margin: 6px 0 4px;
            background: #00000066;
            border-radius: 50px;
            padding: 4px;
        }
        .called-history {
            background: #1e1610;
            padding: 6px 12px;
            border-radius: 40px;
            font-size: 0.7rem;
            color: #efcd91;
            font-weight: bold;
            overflow-x: auto;
            white-space: nowrap;
            font-family: monospace;
            text-align: center;
            margin-top: 6px;
        }

        .balance-top {
            display: flex;
            flex-wrap: wrap;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
            background: #f0efee;
            padding: 8px 12px;
            border-radius: 50px;
            margin-bottom: 15px;
        }

        .players-badge {
            background: #4f3b26;
            padding: 4px 12px;
            border-radius: 30px;
            color: #ffda99;
            font-weight: bold;
            font-size: 0.8rem;
            white-space: nowrap;
        }

        .timer-badge {
            font-size: 1.5rem;
            font-weight: 800;
            font-family: monospace;
            color: #fabe4c;
            background: #171007;
            padding: 0 16px;
            border-radius: 50px;
        }

        .grid-100 {
            display: grid;
            grid-template-columns: repeat(10, 1fr);
            gap: 5px;
            margin: 12px 0;
            background: #efe2ce;
            padding: 8px;
            border-radius: 28px;
        }

        .grid-cell {
            background: #f6eedb;
            border-radius: 12px;
            aspect-ratio: 1 / 1;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 800;
            font-size: 0.7rem;
            color: #3c2a1b;
            border: 2px solid #cb9f66;
            cursor: pointer;
            transition: 0.05s linear;
            font-family: monospace;
            min-width: 28px;
        }

        .grid-cell.taken {
            background: #aa7e54;
            color: #1e170f;
            text-decoration: line-through;
            opacity: 0.7;
            cursor: not-allowed;
        }

        .grid-cell.selected {
            background: #f3bc5c;
            border: 3px solid #d96c1c;
            box-shadow: 0 0 0 2px #ffe1a0;
        }

        button {
            min-height: 44px;
            min-width: 44px;
        }

        button:active {
            transform: scale(0.97);
        }

        .rules-btn {
            background: #3b2d1f;
            color: #f7d992;
            border: 1px solid #e7b153;
            margin-top: 15px;
            padding: 8px 16px;
            border-radius: 30px;
            font-weight: bold;
            font-size: 0.9rem;
        }

        /* MODALS */
        .modal {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.85);
            backdrop-filter: blur(6px);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            visibility: hidden;
            opacity: 0;
            transition: 0.2s;
        }
        .modal.active {
            visibility: visible;
            opacity: 1;
        }
        .modal-content {
            background: #ffffff;
            border-radius: 28px;
            padding: 20px;
            max-width: 92%;
            width: 380px;
            max-height: 85vh;
            overflow-y: auto;
            border: none;
            font-family: 'Inter', system-ui, sans-serif;
            box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
        }
        .bank-header {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 20px;
            border-bottom: 2px solid #e2e8f0;
            padding-bottom: 10px;
        }
        .bank-icon { font-size: 1.8rem; }
        .bank-title { font-size: 1.3rem; font-weight: 800; color: #1e293b; }
        .bank-sub { color: #475569; font-size: 0.75rem; }
        .account-card {
            background: #f1f5f9;
            border-radius: 20px;
            padding: 12px;
            margin: 12px 0;
            border-left: 4px solid #f59e0b;
        }
        .account-label { font-size: 0.65rem; text-transform: uppercase; color: #64748b; }
        .account-number { font-size: 1.1rem; font-weight: 700; font-family: monospace; color: #0f172a; word-break: break-all; }
        .input-group { margin: 12px 0; }
        .input-group label { display: block; font-size: 0.75rem; font-weight: 600; color: #334155; margin-bottom: 4px; }
        .input-group input, .input-group .file-label {
            width: 100%;
            padding: 12px;
            border-radius: 50px;
            border: 1px solid #cbd5e1;
            background: #f8fafc;
            font-size: 0.9rem;
        }
        .file-label { display: block; text-align: center; background: #fef3c7; cursor: pointer; font-weight: 600; color: #b45309; }
        .transaction-summary { background: #eef2ff; border-radius: 20px; padding: 10px; margin: 12px 0; font-size: 0.8rem; }
        .modal-buttons { display: flex; gap: 10px; margin-top: 16px; }
        .modal-buttons button { flex: 1; padding: 12px; border-radius: 50px; font-weight: 700; border: none; cursor: pointer; font-size: 0.9rem; }
        .btn-primary { background: #f59e0b; color: #1e293b; }
        .btn-secondary { background: #e2e8f0; color: #334155; }
        .type-btn { background: #f1f5f9; display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: 50px; margin: 6px 0; font-weight: 600; border: 1px solid #e2e8f0; width: 100%; cursor: pointer; font-size: 0.9rem; }

        /* WINNER OVERLAY */
        .winner-modal {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.85);
            backdrop-filter: blur(12px);
            z-index: 2000;
            display: flex;
            align-items: center;
            justify-content: center;
            visibility: hidden;
            opacity: 0;
        }
        .winner-modal.active { visibility: visible; opacity: 1; }
        .winner-card {
            background: #fffbee;
            border-radius: 40px;
            padding: 20px;
            text-align: center;
            border: 4px solid #ffb347;
            width: 85%;
            max-width: 300px;
        }
        .confetti {
            position: fixed;
            top:0;
            left:0;
            width:100%;
            height:100%;
            pointer-events:none;
            z-index:9999;
        }

        /* separate pages */
        .page-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }
        .back-btn {
            background: #dbbd98;
            border: none;
            padding: 8px 16px;
            border-radius: 40px;
            font-weight: bold;
            cursor: pointer;
        }
        .history-list, .recent-list {
            list-style: none;
            max-height: 500px;
            overflow-y: auto;
        }
        .history-list li, .recent-list li {
            padding: 10px;
            border-bottom: 1px solid #eedbc8;
            font-size: 0.8rem;
        }
        .game-history-card {
            background: #fcf3e5;
            border-radius: 24px;
            padding: 12px;
            margin-bottom: 10px;
        }
        .stat-row {
            display: flex;
            justify-content: space-between;
            margin: 6px 0;
        }
        .profile-stat {
            background: #f1e9dc;
            border-radius: 30px;
            padding: 15px;
            text-align: center;
            margin: 12px 0;
        }
        .stake-page-buttons {
            display: flex;
            gap: 20px;
            justify-content: center;
            margin: 30px 0;
        }
        .stake-option {
            background: #f2e0cc;
            border: none;
            padding: 16px 32px;
            border-radius: 60px;
            font-size: 1.8rem;
            font-weight: 800;
            color: #9b4619;
            box-shadow: 0 5px 0 #c2884b;
            cursor: pointer;
            width: 160px;
        }
        .rules-text {
            background: #fff3e2;
            border-radius: 28px;
            padding: 16px;
            margin-top: 24px;
            font-size: 0.85rem;
        }
        .tab-bar {
            display: flex;
            background: #ede0cf;
            border-radius: 60px;
            margin-top: 20px;
            padding: 6px 8px;
            gap: 6px;
        }
        .tab-btn {
            flex: 1;
            background: transparent;
            border: none;
            padding: 10px 0;
            border-radius: 50px;
            font-weight: 700;
            font-size: 0.9rem;
            color: #8c643e;
            cursor: pointer;
        }
        .tab-btn.active {
            background: #e0853a;
            color: white;
        }

        @media (max-width: 550px) {
            body { padding: 8px; }
            .page { padding: 12px 14px 20px; }
            .card-container td { width: 48px; height: 48px; font-size: 1rem; border-radius: 12px; }
            .card-container thead tr th { font-size: 1.2rem; width: 48px; }
            .grid-cell { font-size: 0.6rem; }
            .last-call-number { font-size: 2rem; }
            .stake-option { padding: 12px 20px; font-size: 1.4rem; width: 130px; }
        }
    </style>
</head>
<body>

    <!-- MODALS (DEPOSIT/WITHDRAW/RULES) -->
    <div id="depositTypeModal" class="modal"><div class="modal-content"><div class="bank-header"><span class="bank-icon">🏦</span><div><div class="bank-title">Deposit</div><div class="bank-sub">Choose payment method</div></div></div><button class="type-btn" data-type="telebirr"><span>📱</span> Telebirr</button><button class="type-btn" data-type="cbebirr"><span>🏦</span> CBE Birr</button><button class="type-btn" data-type="mpesa"><span>📲</span> M-Pesa</button><button id="closeDepositTypeBtn" class="type-btn" style="background:#f1f5f9;">Cancel</button></div></div>
    <div id="depositDetailsModal" class="modal"><div class="modal-content"><div class="bank-header"><span class="bank-icon">💸</span><div><div class="bank-title" id="depositDetailsTitle">Deposit via Telebirr</div><div class="bank-sub">Send payment & attach proof</div></div></div><div class="account-card"><div class="account-label">RECIPIENT ACCOUNT</div><div class="account-number" id="depositAccountNumber">0924839730</div><div class="account-label" style="margin-top:8px;">ACCOUNT NAME</div><div class="account-number" style="font-size:1rem;">DOT BINGO OFFICIAL</div></div><div class="input-group"><label>📞 Your Mobile Number</label><input type="tel" id="depositPlayerPhone" placeholder="" required></div><div class="input-group"><label>💰 Amount (ETB)</label><input type="number" id="depositAmount" placeholder="Min 10 ETB" min="10" step="any"></div><div class="input-group"><label>🧾 Transaction ID (optional)</label><input type="text" id="depositRef" placeholder="e.g., TRX123456"></div><div class="input-group"><label class="file-label" for="depositProofImage">📎 Attach Screenshot / Proof</label><input type="file" id="depositProofImage" accept="image/*" capture="environment" style="display:none;"></div><div class="transaction-summary">💡 After sending, submit proof. Funds added after manual verification.</div><div class="modal-buttons"><button id="submitDepositBtn" class="btn-primary">✔ Submit Request</button><button id="backDepositBtn" class="btn-secondary">← Back</button></div></div></div>
    <div id="withdrawTypeModal" class="modal"><div class="modal-content"><div class="bank-header"><span class="bank-icon">💰</span><div><div class="bank-title">Withdraw Funds</div><div class="bank-sub">Select withdrawal method</div></div></div><button class="type-btn" data-type="telebirr"><span>📱</span> Telebirr</button><button class="type-btn" data-type="cbebirr"><span>🏦</span> CBE Birr</button><button class="type-btn" data-type="mpesa"><span>📲</span> M-Pesa </button><button id="closeWithdrawTypeBtn" class="type-btn">Cancel</button></div></div>
    <div id="withdrawDetailsModal" class="modal"><div class="modal-content"><div class="bank-header"><span class="bank-icon">🏧</span><div><div class="bank-title" id="withdrawDetailsTitle">Withdraw via Telebirr</div><div class="bank-sub">Your account details</div></div></div><div class="input-group"><label>👤 Full Name (as per bank/mobile money)</label><input type="text" id="withdrawName" placeholder="Full name" required></div><div class="input-group"><label>📞 Account / Phone Number</label><input type="text" id="withdrawReceiver" placeholder="" required></div><div class="input-group"><label>💰 Amount (ETB) - Min 20 ETB</label><input type="number" id="withdrawAmount" placeholder="Amount" min="20" step="any"></div><div class="transaction-summary">⏱️ Withdrawals processed within 24h.</div><div class="modal-buttons"><button id="submitWithdrawBtn" class="btn-primary">✔ Request Withdrawal</button><button id="backWithdrawBtn" class="btn-secondary">← Back</button></div></div></div>
    
    <!-- UPDATED RULES MODAL WITH AMHARIC TEXT -->
    <div id="rulesModal" class="modal">
        <div class="modal-content">
            <div class="bank-header"><span class="bank-icon">📜</span><div><div class="bank-title">የቢንጎ ሕጎች</div><div class="bank-sub">75-ኳስ ክላሲክ</div></div></div>
            <div class="rules-text" style="font-size:0.9rem; line-height:1.5;">
                <p><strong>💰 የመግቢያ ክፍያ፦</strong> በአንድ ካርድ 10 ብር</p>
                <p><strong>🏆 የሽልማት ገንዘብ፦</strong> ከጠቅላላ ክፍያ 80% (ለምሳሌ፦ 10 ተጫዋቾች → 80 ብር ሽልማት)</p>
                <p><strong>🎯 የማሸነፍ ሁኔታዎች፦</strong><br>
                • ማንኛውንም አግድም ረድፍ፣ ቀጥ ያለ ዓምድ፣ ወይም ዋና ዲያግናል መሙላት<br>
                • ወይም አራቱንም ማዕዘኖች (ላይ-ግራ፣ ላይ-ቀኝ፣ ታች-ግራ፣ ታች-ቀኝ) ማርክ ማድረግ</p>
                <p><strong>⏱️ የይገባኛል ጥያቄ ሕግ፦</strong> ንድፍዎን ያጠናቀቀውን ቁጥር ተከትሎ ወዲያው “CLAIM BINGO!” ብለው መጫን አለብዎት።<br>
                ❌ ዘግይቶ መጠየቅ (ቀጣዩ ቁጥር ከተጠራ በኋላ) የማይሠራ ነው።</p>
                <p><strong>👥 በርካታ አሸናፊዎች፦</strong> ሽልማቱ በአንድ ቁጥር ላይ ቢንጎ ባገኙ ሁሉ በእኩል ይከፈላል።</p>
            </div>
            <button id="closeRulesBtn" class="btn-primary" style="width:100%; margin-top:16px;">ገባኝ</button>
        </div>
    </div>

    <div id="winnerOverlay" class="winner-modal"><div class="winner-card"><div class="trophy">🏆</div><h2 id="winTitle">BINGO!</h2><div class="winners-list" id="winList"></div><div class="prize" id="winPrize"></div><button onclick="document.getElementById('winnerOverlay').classList.remove('active')" class="btn-primary">🎉 Continue</button></div></div>

    <!-- STAKE SELECTION PAGE -->
    <div id="stakePage" class="page">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
            <h2 style="font-family:'Courier New', monospace; color:#b85c1a; font-size:1.8rem;">🎲 B·I·N·G·O</h2>
            <div class="players-badge">DOT BINGO</div>
        </div>
        <h3 style="text-align:center; margin:20px 0 10px;">Choose Your Stake</h3>
        <div class="stake-page-buttons">
            <button id="stake10Btn" class="stake-option">10 ETB</button>
            <button id="stake20Btn" class="stake-option">20 ETB</button>
        </div>
        <div class="rules-text">
            <h4>🎯 Game Rules</h4>
            <p><strong>💰 Entry fee:</strong> 10 ETB per card.</p>
            <p><strong>🏆 Prize pool:</strong> 80% of total entry fees.</p>
            <p><strong>🎯 Win conditions:</strong><br>
            • Complete any horizontal row, vertical column, or main diagonal<br>
            • OR mark all four corners</p>
            <p><strong>⏱️ Claim rule:</strong> Press “CLAIM BINGO!” immediately after the winning number is called.</p>
            <p><strong>👥 Multiple winners:</strong> Prize split equally.</p>
        </div>
    </div>

    <!-- LOBBY PAGE -->
    <div id="lobbyPage" class="page hidden">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
            <h2 style="font-family:'Courier New', monospace; background: #b5571a; -webkit-background-clip: text; background-clip: text; color:#b85c1a; font-size:1.6rem;">🎲 B·I·N·G·O</h2>
            <div class="players-badge">👥 <span id="playersCount">0</span></div>
        </div>
        <div class="balance-top">
            <div style="font-weight:bold;">💰 BAL <b id="lobbyBalance">0</b> ETB</div>
            <div style="display:flex; gap:8px;">
                <button id="depositBtn" style="background:#6b4c2c; font-size:1rem; padding:6px 14px;">+Deposit</button>
                <button id="withdrawBtn" style="background:#6b4c2c; font-size:1rem; padding:6px 14px;">-Withdraw</button>
            </div>
            <div class="timer-badge" id="lobbyTimer">30s</div>
        </div>
        <div style="display:flex; justify-content:space-between; margin:8px 0; flex-wrap:wrap; gap:8px;">
            <span>🎴 Pick card ID:</span>
            <span>Selected: <span id="selectedNumber">-</span></span>
            <button id="randomCardBtn" style="background:#b5642c; padding:6px 14px;">✨ Random Card</button>
        </div>
        <div id="numberGrid" class="grid-100"></div>
        <div style="margin-top:8px;">🎴 Your Bingo Card Preview</div>
        <div id="lobbyCardPreview" class="card-container"></div>
        
        <div class="tab-bar">
            <button class="tab-btn active" data-page="lobby">🎮 Game</button>
            <button class="tab-btn" data-page="history">📜 History</button>
            <button class="tab-btn" data-page="wallet">💰 Wallet</button>
            <button class="tab-btn" data-page="profile">👤 Profile</button>
        </div>
        
        <button id="rulesBtn" class="rules-btn" style="margin-top:20px;">📜 Game Rules</button>
    </div>

    <!-- HISTORY PAGE -->
    <div id="historyPage" class="page hidden">
        <div class="page-header">
            <h2>📜 Game History</h2>
            <button class="back-btn" id="backFromHistoryBtn">← Back to Lobby</button>
        </div>
        <div><strong>Total Games:</strong> <span id="totalGamesCount">0</span></div>
        <h4 style="margin:15px 0 10px;">Recent Games</h4>
        <div id="recentGamesList" class="recent-list"></div>
    </div>

    <!-- WALLET PAGE -->
    <div id="walletPage" class="page hidden">
        <div class="page-header">
            <h2>💰 My Wallet</h2>
            <button class="back-btn" id="backFromWalletBtn">← Back to Lobby</button>
        </div>
        <div class="profile-stat">
            <div>Current Balance</div>
            <div style="font-size:2rem;" id="walletBalancePage">0</div>
            <button id="depositFromWalletBtn" class="btn-primary" style="width:100%; margin-top:12px;">+ Deposit</button>
            <button id="withdrawFromWalletBtn" class="btn-secondary" style="width:100%; margin-top:8px;">- Withdraw</button>
        </div>
    </div>

    <!-- PROFILE PAGE -->
    <div id="profilePage" class="page hidden">
        <div class="page-header">
            <h2>👤 My Profile</h2>
            <button class="back-btn" id="backFromProfileBtn">← Back to Lobby</button>
        </div>
        <div class="profile-stat">
            <div>Username</div>
            <div><strong id="profileUsername">Player</strong></div>
        </div>
        <div class="profile-stat">
            <div>💰 Balance</div>
            <div style="font-size:1.8rem;" id="profileBalancePage">0</div>
        </div>
        <div class="profile-stat">
            <div>🏆 Total Wins</div>
            <div style="font-size:1.8rem;" id="profileTotalWins">0</div>
        </div>
        <div class="profile-stat">
            <div>💵 Total Earned</div>
            <div style="font-size:1.8rem;" id="profileTotalEarned">0</div>
        </div>
    </div>

    <!-- GAME PAGE -->
    <div id="gamePage" class="page hidden">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:6px;">
            <h2 style="font-size:1.6rem; color:#bb651e;">⚡ BINGO</h2>
            <div class="players-badge">👥 <span id="gamePlayersCount">0</span></div>
        </div>
        <div style="background:#30251b; border-radius:40px; text-align:center; padding:6px; margin:6px 0;">
            <span style="color:#eac67e; font-size:0.9rem;">🏆 PRIZE POOL</span>
            <div id="winningBalance" style="font-size:1.6rem; font-weight:800; color:#f5bc70;">0 ETB</div>
        </div>
        <div class="last-call-area">
            <div class="last-call-label">🎲 LAST CALL</div>
            <div class="last-call-number" id="currentCall">0 - 75</div>
            <div class="called-history" id="calledList">Called: —</div>
        </div>
        <div id="gameCard" class="card-container"></div>
        <button id="bingoBtn" class="claim-bingo-btn">🏆 CLAIM BINGO! 🏆</button>
        <button id="rulesBtnGame" class="rules-btn" style="width:100%; margin-top:8px;">📜 Game Rules</button>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.ready();
        tg.expand();
        let socket, userCard = [], markedNumbers = [], isGameActive = false, lobbyTimerInterval = null, selectedCardNumber = null;
        let depositAccounts = {}, selectedDepositType = null, selectedWithdrawType = null;
        let lastWinAmount = 0;
        let takenNumbers = new Set();
        let currentBalance = 0;

        let totalGames = 0;
        let totalWins = 0;
        let totalEarned = 0;
        let recentGames = [];
        let currentGameId = null;

        function loadStats() {
            try {
                totalGames = parseInt(localStorage.getItem('dot_bingo_total_games') || '0');
                totalWins = parseInt(localStorage.getItem('dot_bingo_total_wins') || '0');
                totalEarned = parseInt(localStorage.getItem('dot_bingo_total_earned') || '0');
                recentGames = JSON.parse(localStorage.getItem('dot_bingo_recent_games') || '[]');
            } catch(e) {}
            updateStatsUI();
        }
        function saveStats() {
            localStorage.setItem('dot_bingo_total_games', totalGames);
            localStorage.setItem('dot_bingo_total_wins', totalWins);
            localStorage.setItem('dot_bingo_total_earned', totalEarned);
            localStorage.setItem('dot_bingo_recent_games', JSON.stringify(recentGames.slice(0, 10)));
        }
        function updateStatsUI() {
            document.getElementById('totalGamesCount').innerText = totalGames;
            document.getElementById('profileTotalWins').innerText = totalWins;
            document.getElementById('profileTotalEarned').innerText = totalEarned;
            const recentDiv = document.getElementById('recentGamesList');
            if (recentDiv) {
                if (recentGames.length === 0) recentDiv.innerHTML = '<div class="game-history-card">No recent games</div>';
                else {
                    recentDiv.innerHTML = recentGames.map(g => `
                        <div class="game-history-card">
                            <div><strong>Game ${g.gameId}</strong> - ${g.date}</div>
                            <div class="stat-row"><span>Result:</span> <strong style="color:${g.result === 'Win' ? '#2e7d32' : '#c62828'}">${g.result}</strong></div>
                            <div class="stat-row"><span>Stake:</span> ${g.stake} ETB</div>
                            <div class="stat-row"><span>Cards:</span> ${g.cards}</div>
                            <div class="stat-row"><span>Prize:</span> ${g.prize} ETB</div>
                            <div class="stat-row"><span>Winners:</span> ${g.winners}</div>
                        </div>
                    `).join('');
                }
            }
        }
        function addGameRecord(win, prize, gameId, cardCount, winnerCount) {
            totalGames++;
            if (win) {
                totalWins++;
                totalEarned += prize;
            }
            recentGames.unshift({
                gameId: gameId,
                date: new Date().toLocaleString(),
                result: win ? 'Win' : 'Lost',
                stake: 10,
                cards: cardCount,
                prize: prize,
                winners: winnerCount
            });
            if (recentGames.length > 10) recentGames.pop();
            saveStats();
            updateStatsUI();
        }

        const stakePage = document.getElementById('stakePage');
        const lobbyPage = document.getElementById('lobbyPage');
        const gamePage = document.getElementById('gamePage');
        const historyPage = document.getElementById('historyPage');
        const walletPage = document.getElementById('walletPage');
        const profilePage = document.getElementById('profilePage');
        const lobbyTimerEl = document.getElementById('lobbyTimer'), playersCountEl = document.getElementById('playersCount');
        const lobbyBalanceEl = document.getElementById('lobbyBalance');
        const gamePlayersCountEl = document.getElementById('gamePlayersCount'), winningBalanceEl = document.getElementById('winningBalance');
        const currentCallEl = document.getElementById('currentCall'), calledListEl = document.getElementById('calledList');
        const selectedNumberEl = document.getElementById('selectedNumber'), numberGrid = document.getElementById('numberGrid');
        const lobbyCardPreview = document.getElementById('lobbyCardPreview');

        function syncBalance(value) {
            currentBalance = value;
            lobbyBalanceEl.innerText = value;
            if (document.getElementById('walletBalancePage')) document.getElementById('walletBalancePage').innerText = value;
            if (document.getElementById('profileBalancePage')) document.getElementById('profileBalancePage').innerText = value;
        }

        function renderCard(card, containerId, clickable = false) {
            const cont = document.getElementById(containerId);
            if(!cont) return;
            cont.innerHTML = '';
            const table = document.createElement('table');
            table.style.borderCollapse = 'separate'; table.style.borderSpacing = '6px';
            const thead = document.createElement('thead');
            const headerRow = document.createElement('tr');
            ['B', 'I', 'N', 'G', 'O'].forEach(l => { let th = document.createElement('th'); th.textContent = l; headerRow.appendChild(th); });
            thead.appendChild(headerRow); table.appendChild(thead);
            const tbody = document.createElement('tbody');
            for(let r=0;r<5;r++) {
                const tr = document.createElement('tr');
                for(let c=0;c<5;c++) {
                    const val = card[r][c];
                    const td = document.createElement('td');
                    td.textContent = val === 'FREE' ? '★' : val;
                    if(val === 'FREE') td.classList.add('free');
                    if(markedNumbers.includes(val)) td.classList.add('marked');
                    if(clickable && val !== 'FREE') { td.style.cursor = 'pointer'; td.onclick = () => { if(isGameActive && socket) socket.emit('markNumber', val); }; }
                    tr.appendChild(td);
                }
                tbody.appendChild(tr);
            }
            table.appendChild(tbody); cont.appendChild(table);
        }

        function buildNumberGrid() {
            numberGrid.innerHTML = '';
            for(let i=1;i<=100;i++) {
                const cell = document.createElement('div');
                cell.className = 'grid-cell';
                cell.dataset.number = i;
                cell.textContent = i;
                if(takenNumbers.has(i)) cell.classList.add('taken');
                else cell.onclick = () => { if(!isGameActive && socket && !takenNumbers.has(i)) socket.emit('selectCardNumber', i); };
                numberGrid.appendChild(cell);
            }
            if(selectedCardNumber) {
                const sel = numberGrid.querySelector(`[data-number='${selectedCardNumber}']`);
                if(sel) sel.classList.add('selected');
            }
        }
        function updateGridWithTakenNumbers(nums) { takenNumbers = new Set(nums); buildNumberGrid(); }
        function getBingoLetter(num) { if(num<=15) return 'B'; if(num<=30) return 'I'; if(num<=45) return 'N'; if(num<=60) return 'G'; return 'O'; }
        function formatCall(num) { return `${getBingoLetter(num)}-${num}`; }
        function popCall() { currentCallEl.classList.add('pop'); setTimeout(()=>currentCallEl.classList.remove('pop'),150); }

        function showLobby(timeLeft) {
            stakePage.classList.add('hidden');
            lobbyPage.classList.remove('hidden');
            gamePage.classList.add('hidden');
            historyPage.classList.add('hidden');
            walletPage.classList.add('hidden');
            profilePage.classList.add('hidden');
            isGameActive = false;
            markedNumbers = [];
            if(socket) socket.emit('getBalance');
            startTimer(timeLeft || 30);
            if(userCard.length) renderCard(userCard, 'lobbyCardPreview', false);
            updateStatsUI();
        }
        function showGame() {
            lobbyPage.classList.add('hidden');
            gamePage.classList.remove('hidden');
            isGameActive = true;
            clearInterval(lobbyTimerInterval);
            if(socket) socket.emit('getBalance');
            if(userCard.length) renderCard(userCard, 'gameCard', true);
        }
        function startTimer(seconds) {
            let left = seconds;
            lobbyTimerEl.textContent = left+'s';
            clearInterval(lobbyTimerInterval);
            lobbyTimerInterval = setInterval(() => {
                left--;
                if(left <= 0) { clearInterval(lobbyTimerInterval); showGame(); }
                else lobbyTimerEl.textContent = left+'s';
            },1000);
        }

        async function loadDepositAccounts() { try { const res = await fetch('/api/deposit-accounts'); depositAccounts = await res.json(); } catch(e) {} }
        function openDepositTypeModal() { document.getElementById('depositTypeModal').classList.add('active'); }
        function closeDepositTypeModal() { document.getElementById('depositTypeModal').classList.remove('active'); }
        function openDepositDetailsModal(type) {
            selectedDepositType = type;
            let acc = '', title = '', phoneHint = '';
            if(type === 'telebirr') { title = 'Telebirr'; acc = depositAccounts.telebirr || '0924839730'; phoneHint = '09xxxxxxxx'; }
            else if(type === 'cbebirr') { title = 'CBE Birr'; acc = depositAccounts.cbebirr || '1000123456789'; phoneHint = '09xxxxxxxx'; }
            else { title = 'M-Pesa'; acc = depositAccounts.mpesa || '0712345678'; phoneHint = '07xxxxxxxx'; }
            document.getElementById('depositDetailsTitle').innerHTML = `Deposit via ${title}`;
            document.getElementById('depositAccountNumber').innerText = acc;
            const phoneInput = document.getElementById('depositPlayerPhone');
            phoneInput.placeholder = phoneHint;
            phoneInput.value = '';
            document.getElementById('depositAmount').value = '';
            document.getElementById('depositRef').value = '';
            document.getElementById('depositProofImage').value = '';
            document.getElementById('depositDetailsModal').classList.add('active');
            closeDepositTypeModal();
        }
        async function submitDepositWithProof() {
            const phone = document.getElementById('depositPlayerPhone').value.trim();
            const amount = document.getElementById('depositAmount').value.trim();
            const file = document.getElementById('depositProofImage').files[0];
            let phoneValid = false;
            if(selectedDepositType === 'mpesa') {
                phoneValid = /^07\d{8}$/.test(phone);
                if(!phoneValid) return alert('Invalid M-Pesa number. Must start with 07 and have 10 digits');
            } else if(selectedDepositType === 'telebirr' || selectedDepositType === 'cbebirr') {
                phoneValid = /^09\d{8}$/.test(phone);
                if(!phoneValid) return alert(`Invalid ${selectedDepositType} number. Must start with 09 and have 10 digits`);
            }
            if(!amount || isNaN(amount) || Number(amount) < 10) return alert('Minimum deposit 10 ETB');
            if(!file) return alert('Please attach payment proof');
            const fd = new FormData();
            fd.append('phone', phone); fd.append('amount', amount); fd.append('payment_type', selectedDepositType); fd.append('proof', file);
            const res = await fetch('/api/request-deposit', { method: 'POST', body: fd });
            const data = await res.json();
            alert(`✅ ${data.message || 'Deposit request submitted!'}`);
            document.getElementById('depositDetailsModal').classList.remove('active');
        }
        function openWithdrawTypeModal() { document.getElementById('withdrawTypeModal').classList.add('active'); }
        function openWithdrawDetailsModal(type) {
            selectedWithdrawType = type;
            let title = (type === 'telebirr' ? 'Telebirr' : type === 'cbebirr' ? 'CBE Birr' : 'M-Pesa');
            let phoneHint = (type === 'mpesa') ? '07xxxxxxxx' : '09xxxxxxxx';
            document.getElementById('withdrawDetailsTitle').innerHTML = `Withdraw via ${title}`;
            const receiverInput = document.getElementById('withdrawReceiver');
            receiverInput.placeholder = phoneHint;
            receiverInput.value = '';
            document.getElementById('withdrawAmount').value = '';
            document.getElementById('withdrawName').value = '';
            document.getElementById('withdrawDetailsModal').classList.add('active');
            document.getElementById('withdrawTypeModal').classList.remove('active');
        }
        async function submitWithdrawRequest() {
            const receiver = document.getElementById('withdrawReceiver').value.trim();
            const amount = document.getElementById('withdrawAmount').value.trim();
            const name = document.getElementById('withdrawName').value.trim();
            if(!name) return alert("Full name required");
            if(!amount || isNaN(amount) || Number(amount) < 20) return alert('Minimum withdrawal 20 ETB');
            let receiverValid = false;
            if(selectedWithdrawType === 'mpesa') {
                receiverValid = /^07\d{8}$/.test(receiver);
                if(!receiverValid) return alert('Invalid M-Pesa number. Must start with 07 and have 10 digits');
            } else if(selectedWithdrawType === 'telebirr' || selectedWithdrawType === 'cbebirr') {
                receiverValid = /^09\d{8}$/.test(receiver);
                if(!receiverValid) return alert(`Invalid ${selectedWithdrawType} number. Must start with 09 and have 10 digits`);
            }
            const res = await fetch('/api/request-withdraw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount, phone: receiver, withdrawal_type: selectedWithdrawType, name })
            });
            const data = await res.json();
            alert(`💸 ${data.message || 'Withdrawal request submitted!'}`);
            document.getElementById('withdrawDetailsModal').classList.remove('active');
        }

        function showWinnerOverlay(data) {
            if(data.noWinner) { alert('No winner this round.'); return; }
            const prize = data.prizeEach || data.totalPrize || 0;
            lastWinAmount = prize;
            document.getElementById('winTitle').innerHTML = (data.winners?.length > 1 ? `${data.winners.length} Winners!` : '🎉 BINGO!');
            document.getElementById('winList').innerHTML = (data.winners || [data.winner]).join(', ');
            document.getElementById('winPrize').innerHTML = prize + ' ETB';
            document.getElementById('winnerOverlay').classList.add('active');
            const confDiv = document.createElement('div'); confDiv.className = 'confetti';
            for(let i=0;i<80;i++){ let p=document.createElement('div'); p.className='confetti-piece'; p.style.left=Math.random()*100+'%'; p.style.animationDuration=(Math.random()*3+2)+'s'; p.style.backgroundColor=`hsl(${Math.random()*360},80%,60%)`; confDiv.appendChild(p); }
            document.body.appendChild(confDiv); setTimeout(()=>confDiv.remove(),3500);
            if (currentGameId) {
                addGameRecord(true, prize, currentGameId, 1, data.winners?.length || 1);
            }
        }

        async function connect() {
            const initData = tg.initData;
            if(!initData){ alert('Open inside Telegram'); return; }
            try { const res = await fetch('/api/telegram-miniapp-auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData})}); const data = await res.json(); if(!data.success) { alert('Auth failed'); return; } 
                document.getElementById('profileUsername').innerText = data.username || 'Player';
            } catch(e) { alert('Network error'); return; }
            socket = io();
            socket.on('connect',()=>{ socket.emit('joinLobby'); });
            socket.on('balanceUpdate', bal => { syncBalance(bal); });
            socket.on('lobbyState', state => { showLobby(state.startsIn); if(state.takenNumbers) updateGridWithTakenNumbers(state.takenNumbers); if(state.playersCount) playersCountEl.innerText = state.playersCount; });
            socket.on('yourCard', card => { userCard = card; if(isGameActive) renderCard(card,'gameCard',true); else renderCard(card,'lobbyCardPreview',false); });
            socket.on('cardTaken', data => { updateGridWithTakenNumbers(data.takenNumbers); selectedCardNumber=null; selectedNumberEl.textContent='-'; });
            socket.on('cardSelectionFailed', msg => alert(msg));
            socket.on('playersCount', c => { playersCountEl.innerText=c; if(gamePlayersCountEl) gamePlayersCountEl.innerText=c; const prize=Math.floor(c*10*0.8); winningBalanceEl.innerText=prize; });
            socket.on('gameStarted', data => { if(data?.prizePool) winningBalanceEl.innerText=data.prizePool; if(data?.playersCount) gamePlayersCountEl.innerText=data.playersCount; showGame(); 
                currentGameId = 'GAME_' + Date.now().toString(36).toUpperCase();
            });
            socket.on('numberCalled', data => { currentCallEl.innerText = formatCall(data.number); popCall(); const list = (data.calledNumbers || []).map(n=>formatCall(n)); calledListEl.innerText = 'Called: '+list.join(', '); });
            socket.on('calledNumbers', called => { const list = called.map(n=>formatCall(n)); calledListEl.innerText = 'Called: '+list.join(', '); });
            socket.on('markedNumbers', nums => { markedNumbers = nums; if(isGameActive && userCard.length) renderCard(userCard,'gameCard',true); else if(!isGameActive && userCard.length) renderCard(userCard,'lobbyCardPreview',false); });
            socket.on('gameEnded', (data) => {
                if (data.winningNumber) {
                    const winningFormatted = formatCall(data.winningNumber);
                    document.getElementById('currentCall').innerText = winningFormatted;
                }
                showWinnerOverlay(data);
                if (data.noWinner && currentGameId) {
                    addGameRecord(false, 0, currentGameId, 0, 0);
                }
                currentGameId = null;
            });
            socket.on('invalidBingo', () => alert('❌ Not a valid bingo yet!'));
            socket.on('depositStatus', data => { if(data.status==='approved') alert(`✅ Deposit +${data.amount} ETB approved!`); else alert('❌ Deposit rejected.'); });
            socket.on('withdrawStatus', data => { if(data.status==='approved') alert(`✅ Withdrawal -${data.amount} ETB processed.`); else alert('❌ Withdrawal rejected.'); });
        }

        document.getElementById('stake10Btn')?.addEventListener('click', () => {
            alert('You selected 10 ETB stake. Game entry is 10 ETB.');
            loadStats();
            showLobby(30);
        });
        document.getElementById('stake20Btn')?.addEventListener('click', () => {
            alert('20 ETB stake is coming soon! Currently using 10 ETB entry fee.');
            loadStats();
            showLobby(30);
        });

        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const pageName = btn.getAttribute('data-page');
                if (lobbyTimerInterval) clearInterval(lobbyTimerInterval);
                if (pageName === 'lobby') {
                    showLobby(parseInt(lobbyTimerEl.textContent) || 30);
                } else if (pageName === 'history') {
                    lobbyPage.classList.add('hidden');
                    historyPage.classList.remove('hidden');
                } else if (pageName === 'wallet') {
                    lobbyPage.classList.add('hidden');
                    walletPage.classList.remove('hidden');
                    syncBalance(currentBalance);
                } else if (pageName === 'profile') {
                    lobbyPage.classList.add('hidden');
                    profilePage.classList.remove('hidden');
                    syncBalance(currentBalance);
                    updateStatsUI();
                }
            });
        });
        document.getElementById('backFromHistoryBtn')?.addEventListener('click', () => { showLobby(30); });
        document.getElementById('backFromWalletBtn')?.addEventListener('click', () => { showLobby(30); });
        document.getElementById('backFromProfileBtn')?.addEventListener('click', () => { showLobby(30); });
        document.getElementById('depositFromWalletBtn')?.addEventListener('click', openDepositTypeModal);
        document.getElementById('withdrawFromWalletBtn')?.addEventListener('click', openWithdrawTypeModal);
        document.getElementById('depositBtn')?.addEventListener('click', openDepositTypeModal);
        document.getElementById('withdrawBtn')?.addEventListener('click', openWithdrawTypeModal);
        document.getElementById('randomCardBtn')?.addEventListener('click', () => { if(!isGameActive && socket) socket.emit('newCardNumber'); });
        document.getElementById('bingoBtn')?.addEventListener('click', () => { if(socket && isGameActive) socket.emit('claimBingo'); });
        document.querySelectorAll('#depositTypeModal .type-btn[data-type]').forEach(btn => btn.addEventListener('click',()=>openDepositDetailsModal(btn.dataset.type)));
        document.getElementById('closeDepositTypeBtn')?.addEventListener('click',closeDepositTypeModal);
        document.getElementById('backDepositBtn')?.addEventListener('click',()=>{ document.getElementById('depositDetailsModal').classList.remove('active'); openDepositTypeModal(); });
        document.getElementById('submitDepositBtn')?.addEventListener('click',submitDepositWithProof);
        document.querySelectorAll('#withdrawTypeModal .type-btn[data-type]').forEach(btn => btn.addEventListener('click',()=>openWithdrawDetailsModal(btn.dataset.type)));
        document.getElementById('closeWithdrawTypeBtn')?.addEventListener('click',()=>document.getElementById('withdrawTypeModal').classList.remove('active'));
        document.getElementById('backWithdrawBtn')?.addEventListener('click',()=>{ document.getElementById('withdrawDetailsModal').classList.remove('active'); openWithdrawTypeModal(); });
        document.getElementById('submitWithdrawBtn')?.addEventListener('click',submitWithdrawRequest);
        
        // Rules buttons open the modal
        const rulesModal = document.getElementById('rulesModal');
        const closeRulesBtn = document.getElementById('closeRulesBtn');
        document.getElementById('rulesBtn')?.addEventListener('click',() => rulesModal.classList.add('active'));
        document.getElementById('rulesBtnGame')?.addEventListener('click',() => rulesModal.classList.add('active'));
        closeRulesBtn?.addEventListener('click',() => rulesModal.classList.remove('active'));
        
        loadDepositAccounts();
        buildNumberGrid();
        loadStats();
        connect();
        stakePage.classList.remove('hidden');
        lobbyPage.classList.add('hidden');
        gamePage.classList.add('hidden');
        historyPage.classList.add('hidden');
        walletPage.classList.add('hidden');
        profilePage.classList.add('hidden');
    </script>
</body>
</html>
