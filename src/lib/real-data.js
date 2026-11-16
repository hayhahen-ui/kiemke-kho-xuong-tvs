export function unpackRealDataBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    throw new Error('Dữ liệu gói thực tế không hợp lệ.');
  }

  let chemicalNorms = bundle.chemicalNorms || [];
  if (bundle.compactChemical?.rows && Array.isArray(bundle.compactChemical.stringPool)) {
    const { batchId, stringPool, chemColumns, chemNumeric, rows } = bundle.compactChemical;
    const strCount = chemColumns.length;
    chemicalNorms = rows.map((tuple) => {
      const item = { batchId };
      for (let i = 0; i < strCount; i += 1) {
        item[chemColumns[i]] = stringPool[tuple[i]] ?? '';
      }
      for (let j = 0; j < chemNumeric.length; j += 1) {
        item[chemNumeric[j]] = tuple[strCount + j];
      }
      return item;
    });
  }

  return {
    materials: bundle.materials || [],
    bom: bundle.bom || [],
    norms: bundle.norms || [],
    orders: bundle.orders || [],
    productionOrders: bundle.productionOrders || [],
    productMappings: bundle.productMappings || [],
    orderMappings: bundle.orderMappings || [],
    chemicalNorms,
    inventory: bundle.inventory || {},
    importMeta: bundle.importMeta || {},
    workshopCounts: bundle.workshopCounts || null,
    materialIssues: bundle.materialIssues || [],
  };
}

export async function fetchRealDataBundle() {
  const response = await fetch('/real-data-bundle.json');
  if (!response.ok) {
    throw new Error(`Không tải được gói dữ liệu thực tế (${response.status}).`);
  }
  const json = await response.json();
  return unpackRealDataBundle(json);
}
