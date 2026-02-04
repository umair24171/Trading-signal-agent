"""
MT5 BRIDGE SERVER
Run this on the same machine where MetaTrader 5 is installed.
Receives signals from Node.js agent and executes trades.

Install requirements:
pip install flask MetaTrader5

Run:
python server.py
"""

from flask import Flask, request, jsonify
import MetaTrader5 as mt5
from datetime import datetime

app = Flask(__name__)

# Initialize MT5 connection
def init_mt5():
    if not mt5.initialize():
        print("MT5 initialization failed")
        return False
    
    account_info = mt5.account_info()
    if account_info:
        print(f"Connected to account: {account_info.login}")
        print(f"Balance: {account_info.balance}")
        print(f"Server: {account_info.server}")
        return True
    return False

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'running',
        'mt5_connected': mt5.terminal_info() is not None,
        'timestamp': datetime.now().isoformat()
    })

@app.route('/account', methods=['GET'])
def account():
    info = mt5.account_info()
    if info:
        return jsonify({
            'login': info.login,
            'balance': info.balance,
            'equity': info.equity,
            'margin': info.margin,
            'free_margin': info.margin_free,
            'profit': info.profit
        })
    return jsonify({'error': 'Not connected'}), 500

@app.route('/trade', methods=['POST'])
def trade():
    data = request.json
    
    symbol = data.get('symbol', 'EURUSD')
    action = data.get('action', 'BUY')
    lot_size = float(data.get('lotSize', 0.01))
    stop_loss = float(data.get('stopLoss', 0))
    take_profit = float(data.get('takeProfit', 0))
    comment = data.get('comment', 'Signal Agent')
    
    # Get symbol info
    symbol_info = mt5.symbol_info(symbol)
    if symbol_info is None:
        return jsonify({'success': False, 'error': f'Symbol {symbol} not found'}), 400
    
    if not symbol_info.visible:
        mt5.symbol_select(symbol, True)
    
    # Get current price
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return jsonify({'success': False, 'error': 'Failed to get price'}), 500
    
    price = tick.ask if action == 'BUY' else tick.bid
    
    # Prepare request
    request_dict = {
        'action': mt5.TRADE_ACTION_DEAL,
        'symbol': symbol,
        'volume': lot_size,
        'type': mt5.ORDER_TYPE_BUY if action == 'BUY' else mt5.ORDER_TYPE_SELL,
        'price': price,
        'sl': stop_loss,
        'tp': take_profit,
        'deviation': 20,
        'magic': 123456,
        'comment': comment,
        'type_time': mt5.ORDER_TIME_GTC,
        'type_filling': mt5.ORDER_FILLING_IOC,
    }
    
    # Send order
    result = mt5.order_send(request_dict)
    
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return jsonify({
            'success': False,
            'error': f'Order failed: {result.comment}',
            'retcode': result.retcode
        }), 400
    
    return jsonify({
        'success': True,
        'ticket': result.order,
        'price': result.price,
        'volume': result.volume,
        'symbol': symbol,
        'type': action
    })

@app.route('/positions', methods=['GET'])
def positions():
    positions = mt5.positions_get()
    if positions is None:
        return jsonify({'positions': []})
    
    return jsonify({
        'positions': [{
            'ticket': p.ticket,
            'symbol': p.symbol,
            'type': 'BUY' if p.type == 0 else 'SELL',
            'volume': p.volume,
            'price_open': p.price_open,
            'sl': p.sl,
            'tp': p.tp,
            'profit': p.profit,
            'comment': p.comment
        } for p in positions]
    })

@app.route('/close', methods=['POST'])
def close():
    data = request.json
    ticket = data.get('ticket')
    
    position = mt5.positions_get(ticket=ticket)
    if not position:
        return jsonify({'success': False, 'error': 'Position not found'}), 404
    
    position = position[0]
    
    # Prepare close request
    tick = mt5.symbol_info_tick(position.symbol)
    price = tick.bid if position.type == 0 else tick.ask
    
    request_dict = {
        'action': mt5.TRADE_ACTION_DEAL,
        'symbol': position.symbol,
        'volume': position.volume,
        'type': mt5.ORDER_TYPE_SELL if position.type == 0 else mt5.ORDER_TYPE_BUY,
        'position': ticket,
        'price': price,
        'deviation': 20,
        'magic': 123456,
        'comment': 'Close by Signal Agent',
        'type_time': mt5.ORDER_TIME_GTC,
        'type_filling': mt5.ORDER_FILLING_IOC,
    }
    
    result = mt5.order_send(request_dict)
    
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return jsonify({
            'success': False,
            'error': f'Close failed: {result.comment}'
        }), 400
    
    return jsonify({'success': True, 'ticket': ticket})

if __name__ == '__main__':
    if init_mt5():
        print("\n🚀 MT5 Bridge Server running on http://localhost:5000\n")
        app.run(host='0.0.0.0', port=5000)
    else:
        print("Failed to connect to MT5")