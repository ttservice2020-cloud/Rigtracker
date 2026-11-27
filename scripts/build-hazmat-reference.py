"""Build the Safety search index from GovInfo's 49 CFR 172.101 section XML."""

import argparse
import gzip
import json
from pathlib import Path
import xml.etree.ElementTree as ET


def cell_text(cell):
    return ' '.join(''.join(cell.itertext()).split())


def read_entries(xml):
    root = ET.fromstring(xml)
    table = next(table for table in root.iter('GPOTABLE')
                 if table.get('COLS') == '14' and len(table.findall('ROW')) > 1000)
    results = []
    previous = ['', '', '', '']
    for row in table.findall('ROW')[1:]:
        symbols, name, hazard, number, packing, labels = (
            [cell_text(cell) for cell in row.findall('ENT')[:6]] + [''] * 6
        )[:6]
        if not any(character.isalnum() for character in name):
            name = ''
        if name:
            previous = [symbols, name, hazard, number]
        elif packing:
            symbols, name, hazard, number = [value or inherited for value, inherited in
                                              zip([symbols, name, hazard, number], previous)]
        if name:
            results.append([name, number, hazard, packing, labels, symbols])
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('xml', type=Path)
    parser.add_argument('edition', help='Publication date shown by GovInfo')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    entries = read_entries(args.xml.read_bytes())
    payload = (json.dumps({'edition': args.edition, 'entries': entries}, ensure_ascii=False,
                          separators=(',', ':')) + '\n').encode('utf-8')
    args.output.write_bytes(payload)
    print(f'{len(entries)} entries, {len(payload):,} bytes, {len(gzip.compress(payload)):,} bytes gzip')


if __name__ == '__main__':
    main()
