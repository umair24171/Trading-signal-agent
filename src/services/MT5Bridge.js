import axios from 'axios';

export class MT5Bridge {
  constructor() {
    this.enabled = process.env.MT5_ENABLED === 'true';
    this.serverUrl = process.env.MT5_SERVER_URL || 'http://localhost:5000';
    
    if (this.enabled) {
      console.log('🔗 MT5 Bridge enabled - connecting to:', this.serverUrl);
    }
  }

  async executeSignal(signal) {
    if (!this.enabled) {
      console.log('🔗 [MT5 DISABLED] Would execute:', signal.action, signal.symbol);
      return null;
    }

    try {
      const response = await axios.post(`${this.serverUrl}/trade`, {
        symbol: this.convertSymbol(signal.symbol),
        action: signal.action,
        price: signal.price,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        lotSize: 0.01, // Start small - adjust based on your risk
        comment: `Signal-${signal.confidence}%`
      }, {
        timeout: 10000
      });

      if (response.data.success) {
        console.log('✅ MT5 Trade executed:', response.data);
        return response.data;
      } else {
        console.error('❌ MT5 Trade failed:', response.data.error);
        return null;
      }
    } catch (err) {
      console.error('❌ MT5 Bridge error:', err.message);
      return null;
    }
  }

  async getPositions() {
    if (!this.enabled) return [];

    try {
      const response = await axios.get(`${this.serverUrl}/positions`);
      return response.data.positions || [];
    } catch (err) {
      console.error('❌ Failed to get MT5 positions:', err.message);
      return [];
    }
  }

  async closePosition(ticket) {
    if (!this.enabled) return false;

    try {
      const response = await axios.post(`${this.serverUrl}/close`, { ticket });
      return response.data.success;
    } catch (err) {
      console.error('❌ Failed to close position:', err.message);
      return false;
    }
  }

  // Convert symbol format (EUR/USD -> EURUSD)
  convertSymbol(symbol) {
    return symbol.replace('/', '');
  }
}
