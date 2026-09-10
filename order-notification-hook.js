// Hooks the final order saver after all existing order patches are applied.
// Keeps the existing save/confirmation flow intact and only adds notifications.
const fs = require('fs');
const Module = require('module');
const path = require('path');

const previousLoader = Module._extensions['.js'];

Module._extensions['.js'] = function orderNotificationLoader(module, filename) {
  if (path.basename(filename) !== 'server.js') return previousLoader(module, filename);

  let source = fs.readFileSync(filename, 'utf8');
  const marker = "console.log('✓ Order saved: id=' + (result.rows[0]?.id || 'unknown') + ' agent=' + agentId + ' chat=' + chatId);";

  if (!source.includes(marker)) {
    throw new Error('Order notification hook: final order saver marker not found');
  }

  const replacement = marker + `
    if (typeof global.notifyOrderCreated === 'function') {
      const savedOrder = {
        id: result.rows[0]?.id,
        agent_id: agentId,
        customer_name: orderInfo.customer_name,
        customer_phone: orderInfo.customer_phone,
        customer_address: orderInfo.customer_address,
        order_details: orderInfo.order_details,
        chat_id: String(chatId),
        created_at: new Date().toISOString()
      };
      await global.notifyOrderCreated(savedOrder);
    }`;

  source = source.replace(marker, replacement);
  return previousLoader(module, filename);
};
