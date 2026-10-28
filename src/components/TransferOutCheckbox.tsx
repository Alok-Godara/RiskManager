/** "Transfer out" tick-box shared by the Exit and Correction windows — see Execution.transfer_out. */
export function TransferOutCheckbox({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="form-row">
      <label>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginRight: 6 }} />
        Exit without TC and P&amp;L (transfer to another trade)
      </label>
      <p className="helper-text">
        Tick this when you are moving this position into another trade. These lots then leave this trade as if they had never been
        in it: no profit or loss and no transaction cost (entry or exit) is counted for them here. Enter them in the other trade at
        the same entry price — that trade carries their costs and their P&amp;L from there. The exit price you enter above is not used.
      </p>
    </div>
  );
}
